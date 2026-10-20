export type { EditorView } from '@tiptap/pm/view'
// minimal structural types for the editor paste/drop handlers (tiptap pm view)
export type ClipboardEventLike = { clipboardData?: { files?: FileList | null } | null }
export type DragEventLike = { dataTransfer?: { files?: FileList | null } | null }
