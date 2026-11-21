import { useState, useCallback, useEffect, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface StreamNote {
  streamId: string;
  text: string;
  updatedAt: number;
}

export interface UseStreamNotesResult {
  notes: Record<string, StreamNote>;
  getNote: (streamId: string) => string | null;
  setNote: (streamId: string, text: string) => void;
  removeNote: (streamId: string) => void;
  exportNotes: () => string;
  importNotes: (json: string) => boolean;
  clearNotes: () => void;
}

function openNotesStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open('streamfi-notes', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function loadNotesIndexedDB(): Promise<Record<string, StreamNote>> {
  const notes: Record<string, StreamNote> = {};
  try {
    const db = await openNotesStore();
    const tx = db.transaction('notes', 'readonly');
    const store = tx.objectStore('notes');
    const [keys, values] = await Promise.all([
      new Promise<string[]>((resolve) => {
        const req = store.getAllKeys();
        req.onsuccess = () => resolve(req.result as string[]);
        req.onerror = () => resolve([]);
      }),
      new Promise<string[]>((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result as string[]);
        req.onerror = () => resolve([]);
      }),
    ]);
    for (let i = 0; i < keys.length; i++) {
      try {
        const parsed = JSON.parse(values[i]);
        if (parsed && typeof parsed === 'object' && 'text' in parsed && 'updatedAt' in parsed) {
          notes[keys[i]] = parsed as StreamNote;
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return notes;
}

function loadNotesLocalStorage(): Record<string, StreamNote> {
  const notes: Record<string, StreamNote> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('streamfi-note:')) {
        try {
          const parsed = JSON.parse(localStorage.getItem(key) ?? '');
          if (parsed && typeof parsed === 'object' && 'text' in parsed && 'updatedAt' in parsed) {
            notes[key.replace('streamfi-note:', '')] = parsed as StreamNote;
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }
  return notes;
}

async function loadNotesFromStorage(): Promise<Record<string, StreamNote>> {
  const dbNotes = await loadNotesIndexedDB();
  if (Object.keys(dbNotes).length > 0) return dbNotes;
  return loadNotesLocalStorage();
}

async function saveNoteToStorage(id: string, note: StreamNote): Promise<void> {
  const json = JSON.stringify(note);
  try {
    if (typeof indexedDB !== 'undefined') {
      const db = await openNotesStore();
      const tx = db.transaction('notes', 'readwrite');
      tx.objectStore('notes').put(json, id);
      return;
    }
  } catch { /* ignore */ }
  try {
    localStorage.setItem(`streamfi-note:${id}`, json);
  } catch { /* ignore */ }
}

async function deleteNoteFromStorage(id: string): Promise<void> {
  try {
    if (typeof indexedDB !== 'undefined') {
      const db = await openNotesStore();
      const tx = db.transaction('notes', 'readwrite');
      tx.objectStore('notes').delete(id);
      return;
    }
  } catch { /* ignore */ }
  try {
    localStorage.removeItem(`streamfi-note:${id}`);
  } catch { /* ignore */ }
}

/**
 * Persists stream notes to indexedDB (preferred) with localStorage fallback.
 * Provides get, set, remove, export/import, and clear operations.
 *
 * @example
 * ```tsx
 * const { notes, getNote, setNote, exportNotes, importNotes } = useStreamNotes(streamId);
 * ```
 */
export function useStreamNotes(streamId: bigint | string | null | undefined): UseStreamNotesResult {
  const { client, isReady } = useStreamFiClient();
  const [notes, setNotes] = useState<Record<string, StreamNote>>({});
  const requestIdRef = useRef(0);
  const initializedRef = useRef(false);

  const loadNotes = useCallback(async () => {
    const id = ++requestIdRef.current;
    const allNotes = await loadNotesFromStorage();
    if (requestIdRef.current !== id) return;
    setNotes(allNotes);
    initializedRef.current = true;
  }, []);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const getNote = useCallback((id: string): string | null => {
    const note = notes[id];
    return note ? note.text : null;
  }, [notes]);

  const setNote = useCallback((id: string, text: string) => {
    const note: StreamNote = { streamId: id, text, updatedAt: Date.now() };
    setNotes((prev) => ({ ...prev, [id]: note }));
    saveNoteToStorage(id, note);
  }, []);

  const removeNote = useCallback((id: string) => {
    setNotes((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    deleteNoteFromStorage(id);
  }, []);

  const exportNotes = useCallback((): string => {
    return JSON.stringify(notes);
  }, [notes]);

  const importNotes = useCallback((json: string): boolean => {
    try {
      const imported = JSON.parse(json);
      if (typeof imported !== 'object' || imported === null || Array.isArray(imported)) return false;
      for (const [id, note] of Object.entries(imported)) {
        if (note && typeof note === 'object' && 'text' in note && 'updatedAt' in note) {
          const sn = note as StreamNote;
          saveNoteToStorage(id, sn);
        }
      }
      setNotes((prev) => ({ ...imported, ...prev }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const clearNotes = useCallback(() => {
    Object.keys(notes).forEach((id) => {
      deleteNoteFromStorage(id);
    });
    setNotes({});
  }, [notes]);

  return {
    notes,
    getNote,
    setNote,
    removeNote,
    exportNotes,
    importNotes,
    clearNotes,
  };
}
