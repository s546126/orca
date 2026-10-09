import { z } from 'zod'
import { FOREIGN_SESSION_HARNESSES } from '../foreign-session-import'

const boundedPath = z.string().min(1).max(4096)
const boundedId = z.string().min(1).max(512)

export const ForeignSessionImportParams = z.object({
  harness: z.enum(FOREIGN_SESSION_HARNESSES),
  paths: z.array(boundedPath).max(100).optional(),
  sessionIds: z.array(boundedId).max(100).optional(),
  workspaceId: boundedId.optional(),
  workspaceKind: z.enum(['git-worktree', 'folder']).optional()
})
