/*
 * One cumulative, app-scoped macOS resource snapshot (no privileges required).
 * Build:
 *   clang -O2 -Wall -Wextra scripts/macos-process-metrics.c \
 *     -framework IOKit -framework CoreFoundation -o .artifacts/tools/process-metrics
 * Usage: process-metrics --root <app-pid>  (0 means the app is closed).
 *
 * CPU rusage time is Mach absolute time; energy_nj is already nanojoules.
 * GPU time is the sum of live IOAccelerator AppUsage.accumulatedGPUTime queues.
 * It is cumulative GPU execution time, not core occupancy or GPU energy.
 * API/units references:
 * https://github.com/vladkens/macmon/blob/v0.12.0/src/app/procs.rs
 * https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h
 */
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

#define PID_COALITION_INFO_FLAVOR 20
#define MAX_RELATION_DEPTH 32

_Static_assert(sizeof(struct rusage_info_v6) == 464, "Check current SDK rusage v6 layout");
_Static_assert(offsetof(struct rusage_info_v6, ri_energy_nj) == 336, "Check rusage energy offset");

typedef struct {
    pid_t pid;
    struct proc_bsdinfo bsd;
    uint64_t coalition;
    bool coalition_known;
    pid_t responsible;
    const char *relation;
    uint64_t gpu_ns;
    unsigned gpu_clients;
    unsigned gpu_usage_clients;
    uint64_t *gpu_client_ids;
    size_t gpu_ids_count;
    size_t gpu_ids_capacity;
    bool gpu_ids_complete;
} Process;

typedef struct {
    bool available;
    bool consistent;
    unsigned services;
} GpuScan;

static uint64_t saturating_add(uint64_t a, uint64_t b) {
    return UINT64_MAX - a < b ? UINT64_MAX : a + b;
}

static uint64_t ticks_to_ns(uint64_t ticks, mach_timebase_info_data_t base) {
    __uint128_t value = (__uint128_t)ticks * base.numer / base.denom;
    return value > UINT64_MAX ? UINT64_MAX : (uint64_t)value;
}

static uint64_t monotonic_ns(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return (uint64_t)value.tv_sec * 1000000000ULL + (uint64_t)value.tv_nsec;
}

static uint64_t unix_ns(void) {
    struct timespec value;
    clock_gettime(CLOCK_REALTIME, &value);
    return (uint64_t)value.tv_sec * 1000000000ULL + (uint64_t)value.tv_nsec;
}

static bool resource_coalition(pid_t pid, uint64_t *value) {
    uint64_t info[5] = {0};
    int read = proc_pidinfo(pid, PID_COALITION_INFO_FLAVOR, 0, info, sizeof(info));
    if (read != sizeof(info) || info[0] == 0) return false;
    *value = info[0];
    return true;
}

static int index_of(const Process *processes, size_t count, pid_t pid) {
    for (size_t i = 0; i < count; i++) if (processes[i].pid == pid) return (int)i;
    return -1;
}

static bool descendant_of(const Process *processes, size_t count, pid_t pid, pid_t root) {
    for (int depth = 0; depth < MAX_RELATION_DEPTH; depth++) {
        int index = index_of(processes, count, pid);
        if (index < 0) return false;
        pid_t parent = (pid_t)processes[index].bsd.pbi_ppid;
        if (parent == root) return true;
        if (parent <= 1 || parent == pid) return false;
        pid = parent;
    }
    return false;
}

static bool responsible_to(const Process *processes, size_t count, pid_t pid, pid_t root) {
    for (int depth = 0; depth < MAX_RELATION_DEPTH; depth++) {
        int index = index_of(processes, count, pid);
        if (index < 0) return false;
        pid_t owner = processes[index].responsible;
        if (owner == root) return true;
        if (owner <= 1 || owner == pid) return false;
        pid = owner;
    }
    return false;
}

static bool parse_creator(CFTypeRef property, pid_t *pid) {
    if (!property || CFGetTypeID(property) != CFStringGetTypeID()) return false;
    char text[512];
    if (!CFStringGetCString((CFStringRef)property, text, sizeof(text), kCFStringEncodingUTF8)) return false;
    if (strncmp(text, "pid ", 4) != 0) return false;
    char *end;
    long value = strtol(text + 4, &end, 10);
    if (end == text + 4 || (*end != ',' && *end != '\0') || value <= 0 || value > INT32_MAX) return false;
    *pid = (pid_t)value;
    return true;
}

static bool read_usage(CFTypeRef property, uint64_t *total) {
    if (!property || CFGetTypeID(property) != CFArrayGetTypeID()) return false;
    CFArrayRef entries = (CFArrayRef)property;
    *total = 0;
    for (CFIndex i = 0; i < CFArrayGetCount(entries); i++) {
        CFTypeRef entry = CFArrayGetValueAtIndex(entries, i);
        if (!entry || CFGetTypeID(entry) != CFDictionaryGetTypeID()) continue;
        CFTypeRef number = CFDictionaryGetValue((CFDictionaryRef)entry, CFSTR("accumulatedGPUTime"));
        int64_t value;
        if (number && CFGetTypeID(number) == CFNumberGetTypeID()
            && CFNumberGetValue((CFNumberRef)number, kCFNumberSInt64Type, &value) && value >= 0) {
            *total = saturating_add(*total, (uint64_t)value);
        }
    }
    return true;
}

static void remember_gpu_client(Process *process, io_object_t client) {
    uint64_t registry_id = 0;
    if (IORegistryEntryGetRegistryEntryID(client, &registry_id) != KERN_SUCCESS) {
        process->gpu_ids_complete = false;
        return;
    }
    if (process->gpu_ids_count == process->gpu_ids_capacity) {
        size_t capacity = process->gpu_ids_capacity ? process->gpu_ids_capacity * 2 : 4;
        uint64_t *ids = realloc(process->gpu_client_ids, capacity * sizeof(uint64_t));
        if (!ids) {
            process->gpu_ids_complete = false;
            return;
        }
        process->gpu_client_ids = ids;
        process->gpu_ids_capacity = capacity;
    }
    process->gpu_client_ids[process->gpu_ids_count++] = registry_id;
}

static int compare_u64(const void *left, const void *right) {
    uint64_t a = *(const uint64_t *)left, b = *(const uint64_t *)right;
    return (a > b) - (a < b);
}

static GpuScan scan_gpu(Process *processes, size_t count) {
    GpuScan result = { .available = false, .consistent = true, .services = 0 };
    bool selected = false;
    for (size_t i = 0; i < count; i++) selected |= processes[i].relation != NULL;
    if (!selected) return result;
    io_iterator_t services = 0;
    kern_return_t status = IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &services);
    if (status != KERN_SUCCESS) return result;
    result.available = true;
    io_object_t gpu;
    while ((gpu = IOIteratorNext(services))) {
        result.services++;
        io_iterator_t children = 0;
        if (IORegistryEntryGetChildIterator(gpu, kIOServicePlane, &children) != KERN_SUCCESS) {
            result.consistent = false;
            IOObjectRelease(gpu);
            continue;
        }
        io_object_t client;
        while ((client = IOIteratorNext(children))) {
            CFTypeRef creator = IORegistryEntryCreateCFProperty(client, CFSTR("IOUserClientCreator"), kCFAllocatorDefault, 0);
            pid_t pid = 0;
            bool parsed = parse_creator(creator, &pid);
            if (creator) CFRelease(creator);
            int index = parsed ? index_of(processes, count, pid) : -1;
            if (index >= 0 && processes[index].relation) {
                Process *process = &processes[index];
                process->gpu_clients++;
                remember_gpu_client(process, client);
                CFTypeRef usage = IORegistryEntryCreateCFProperty(client, CFSTR("AppUsage"), kCFAllocatorDefault, 0);
                uint64_t time = 0;
                if (read_usage(usage, &time)) {
                    process->gpu_ns = saturating_add(process->gpu_ns, time);
                    process->gpu_usage_clients++;
                }
                if (usage) CFRelease(usage);
            }
            IOObjectRelease(client);
        }
        result.consistent &= IOIteratorIsValid(children);
        IOObjectRelease(children);
        IOObjectRelease(gpu);
    }
    result.consistent &= IOIteratorIsValid(services);
    IOObjectRelease(services);
    if (result.services == 0) result.available = false;
    return result;
}

static void json_string(const char *value) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        switch (*p) {
            case '"': fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (*p < 0x20) printf("\\u%04x", *p);
                else putchar(*p);
        }
    }
    putchar('"');
}

int main(int argc, char **argv) {
    if (argc != 3 || strcmp(argv[1], "--root") != 0) {
        fprintf(stderr, "Usage: %s --root <app-pid|0>\n", argv[0]);
        return 2;
    }
    char *end;
    errno = 0;
    long argument = strcmp(argv[2], "self") == 0 ? getpid() : strtol(argv[2], &end, 10);
    if (strcmp(argv[2], "self") != 0 && (errno || *end || end == argv[2] || argument < 0 || argument > INT32_MAX)) {
        fputs("Invalid app pid\n", stderr);
        return 2;
    }
    pid_t root = (pid_t)argument;
    mach_timebase_info_data_t base = {0};
    if (mach_timebase_info(&base) != KERN_SUCCESS || base.denom == 0) return 1;
    uint64_t root_coalition = 0, own_coalition = 0;
    bool root_coalition_known = root > 0 && resource_coalition(root, &root_coalition);
    bool own_coalition_known = resource_coalition(getpid(), &own_coalition);
    bool shared = root_coalition_known && own_coalition_known && root_coalition == own_coalition;
    bool root_alive = false;
    size_t count = 0;
    Process *processes = NULL;
    if (root > 0) {
        int capacity = proc_listallpids(NULL, 0);
        if (capacity <= 0) return 1;
        capacity += 256;
        pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
        processes = calloc((size_t)capacity, sizeof(Process));
        if (!pids || !processes) return 1;
        int length = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
        pid_t (*responsibility)(pid_t) = (pid_t (*)(pid_t))dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
        for (int i = 0; i < length; i++) {
            struct proc_bsdinfo bsd = {0};
            if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd)) != sizeof(bsd) || bsd.pbi_uid != getuid()) continue;
            Process *process = &processes[count++];
            process->pid = pids[i];
            process->gpu_ids_complete = true;
            process->bsd = bsd;
            process->coalition_known = resource_coalition(pids[i], &process->coalition);
            process->responsible = responsibility ? responsibility(pids[i]) : -1;
            if (process->pid == root) root_alive = true;
        }
        free(pids);
        for (size_t i = 0; i < count; i++) {
            Process *process = &processes[i];
            if (process->pid == root) process->relation = "root";
            else if (root_coalition_known && !shared && process->coalition_known && process->coalition == root_coalition) process->relation = "resource_coalition";
            else if (responsible_to(processes, count, process->pid, root)) process->relation = "responsible_pid";
            else if (descendant_of(processes, count, process->pid, root)) process->relation = "descendant";
        }
    }
    GpuScan gpu = scan_gpu(processes, count);
    printf("{\"schema_version\":1,\"monotonic_ns\":%" PRIu64 ",\"unix_ns\":%" PRIu64 ",\"root_pid\":%d,\"root_alive\":%s,", monotonic_ns(), unix_ns(), root, root_alive ? "true" : "false");
    printf("\"root_resource_coalition\":%" PRIu64 ",\"sampler_resource_coalition\":%" PRIu64 ",\"coalition_shared_with_sampler\":%s,", root_coalition, own_coalition, shared ? "true" : "false");
    printf("\"mach_timebase\":{\"numer\":%u,\"denom\":%u},\"gpu_scan\":{\"available\":%s,\"consistent\":%s,\"services\":%u},\"processes\":[", base.numer, base.denom, gpu.available ? "true" : "false", gpu.consistent ? "true" : "false", gpu.services);
    bool first = true;
    for (size_t i = 0; i < count; i++) {
        Process *process = &processes[i];
        if (!process->relation) continue;
        if (!first) putchar(',');
        first = false;
        char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
        proc_pidpath(process->pid, path, sizeof(path));
        const char *name = strrchr(path, '/');
        name = name ? name + 1 : process->bsd.pbi_name;
        printf("{\"pid\":%d,\"ppid\":%u,\"responsible_pid\":%d,\"resource_coalition\":%" PRIu64 ",\"relation\":", process->pid, process->bsd.pbi_ppid, process->responsible, process->coalition);
        json_string(process->relation);
        fputs(",\"name\":", stdout); json_string(name);
        fputs(",\"path\":", stdout); json_string(path);
        struct rusage_info_v6 usage = {0};
        bool energy_available = true;
        int error = proc_pid_rusage(process->pid, RUSAGE_INFO_V6, (rusage_info_t *)&usage);
        if (error != 0) {
            energy_available = false;
            error = proc_pid_rusage(process->pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage);
        }
        if (error == 0) {
            uint64_t user_ns = ticks_to_ns(usage.ri_user_time, base);
            uint64_t system_ns = ticks_to_ns(usage.ri_system_time, base);
            printf(",\"readable\":true,\"process_start_ticks\":%" PRIu64 ",\"cpu_user_ns\":%" PRIu64 ",\"cpu_system_ns\":%" PRIu64 ",\"cpu_time_ns\":%" PRIu64 ",\"physical_footprint_bytes\":%" PRIu64 ",\"cpu_energy_nj\":", usage.ri_proc_start_abstime, user_ns, system_ns, saturating_add(user_ns, system_ns), usage.ri_phys_footprint);
            if (energy_available) printf("%" PRIu64, usage.ri_energy_nj); else fputs("null", stdout);
        } else {
            fputs(",\"readable\":false,\"cpu_energy_nj\":null", stdout);
        }
        printf(",\"gpu_clients\":%u,\"gpu_usage_clients\":%u,\"gpu_client_ids\":", process->gpu_clients, process->gpu_usage_clients);
        if (process->gpu_ids_complete) {
            if (process->gpu_ids_count > 1) qsort(process->gpu_client_ids, process->gpu_ids_count, sizeof(uint64_t), compare_u64);
            putchar('[');
            for (size_t j = 0; j < process->gpu_ids_count; j++) {
                if (j) putchar(',');
                printf("%" PRIu64, process->gpu_client_ids[j]);
            }
            putchar(']');
        } else fputs("null", stdout);
        fputs(",\"gpu_time_ns\":", stdout);
        if (gpu.available && gpu.consistent && process->gpu_usage_clients > 0 && process->gpu_ids_complete) printf("%" PRIu64, process->gpu_ns);
        else fputs("null", stdout);
        putchar('}');
    }
    fputs("]}\n", stdout);
    for (size_t i = 0; i < count; i++) free(processes[i].gpu_client_ids);
    free(processes);
    return root > 0 && !root_alive ? 3 : 0;
}
