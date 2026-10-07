import type { NoteInput, StoredNote } from "./notes.js";

// Carry arbitrary JSON as text across Cloudflare's typed RPC boundary.
// This keeps metadata open-ended without recursive serialization types.
export type NoteWireInput = Pick<NoteInput, "id" | "mode" | "markdown"> & { payloadJson: string };
export type NoteWire = Pick<StoredNote, "sequence" | "id" | "mode" | "markdown" | "receivedAt" | "result"> & { payloadJson: string };

export function noteToWire(note: StoredNote): NoteWire {
  return {
    sequence: note.sequence, id: note.id, mode: note.mode, markdown: note.markdown,
    receivedAt: note.receivedAt, payloadJson: JSON.stringify(note.payload),
    ...(note.result ? { result: note.result } : {}),
  };
}
