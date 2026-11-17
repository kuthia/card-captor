import type { CardStatusEditor } from './contracts';

interface PendingRead {
  revision: number;
  promise: Promise<CardStatusEditor>;
}

interface CacheEntry {
  revision: number;
  value?: CardStatusEditor;
  pending?: PendingRead;
}

function copy(editor: CardStatusEditor): CardStatusEditor {
  return {
    ...editor,
    fields: editor.fields.map(field => ({
      ...field,
      options: field.options.map(option => ({ ...option })),
    })),
  };
}

/**
 * In-memory metadata only. Callers receive detached copies, including for shared reads.
 * Owners clear on connection changes and retain only the currently displayed card IDs.
 */
export class StatusOptionsCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(cardId: string): CardStatusEditor | undefined {
    const value = this.entries.get(cardId)?.value;
    return value ? copy(value) : undefined;
  }

  /** Always revalidates, coalescing concurrent loads for the same live entry. */
  refresh(cardId: string, load: () => Promise<CardStatusEditor>): Promise<CardStatusEditor> {
    let entry = this.entries.get(cardId);
    if (!entry) {
      entry = { revision: 0 };
      this.entries.set(cardId, entry);
    }
    const owned = entry;
    if (owned.pending) return owned.pending.promise.then(copy);

    const forget = () => {
      if (owned.pending === read) owned.pending = undefined;
    };
    const read: PendingRead = {
      revision: owned.revision,
      promise: Promise.resolve().then(load).then(editor => {
        forget();
        if (editor.cardId !== cardId) {
          throw new Error('카드가 변경되었습니다. 상태 목록을 다시 열어 주세요.');
        }
        const value = copy(editor);
        if (this.entries.get(cardId) === owned && owned.revision === read.revision) {
          owned.value = value;
        }
        // An invalidated read still settles for its original caller, without restoring cache data.
        return value;
      }, error => {
        forget();
        throw error;
      }),
    };
    owned.pending = read;
    return read.promise.then(copy);
  }

  /** Confirmed writes win over metadata reads that started before the write. */
  recordChange(cardId: string, fieldId: string, optionId: string): void {
    const entry = this.entries.get(cardId);
    if (!entry) return;
    entry.revision += 1;
    // A new post-write read must not share the older response.
    entry.pending = undefined;
    if (entry.value) {
      entry.value = {
        ...entry.value,
        fields: entry.value.fields.map(field => field.id === fieldId
          ? { ...field, currentOptionId: optionId }
          : field),
      };
    }
  }

  clear(): void {
    this.entries.clear();
  }

  retain(cardIds: readonly string[]): void {
    const retained = new Set(cardIds);
    for (const cardId of this.entries.keys()) {
      if (!retained.has(cardId)) this.entries.delete(cardId);
    }
  }
}
