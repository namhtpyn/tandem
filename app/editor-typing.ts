export type { EditorView } from '@tiptap/pm/view'
// minimal structural types for the editor paste/drop handlers (tiptap pm view)
export interface ClipboardEventLike { clipboardData?: { files?: FileList | null } | null }
export interface DragEventLike { dataTransfer?: { files?: FileList | null } | null }
