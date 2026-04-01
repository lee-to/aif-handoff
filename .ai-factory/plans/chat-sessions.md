<!-- handoff:task:50650b72-73e6-417f-9eb7-77ec3dd1340e -->
# Plan: Add AI Chat Sessions Support

**Branch:** `feature/chat-sessions`
**Created:** 2026-04-01
**Type:** Feature

## Settings

- **Testing:** Yes
- **Logging:** Verbose (DEBUG-level for all new code)
- **Docs:** Yes (mandatory docs checkpoint at completion)

## Roadmap Linkage

- **Milestone:** "AI Chat Sessions"
- **Rationale:** Directly implements the roadmap milestone for persistent chat sessions with history, context carry-over, and session management UI.

## Summary

Add persistent chat sessions so users can maintain conversation state across page reloads and multiple interactions. Currently, all chat state is ephemeral — messages live in React state (lost on refresh) and agent session IDs live in an in-memory `Map` (lost on server restart).

This plan adds:
1. Database tables for chat sessions and messages
2. Data-access layer functions (CRUD)
3. REST API endpoints for session management
4. Persistence of messages during chat streaming
5. Frontend session list/switcher UI in the chat panel
6. Session auto-creation, rename, and delete functionality

## Research Context

The existing chat system uses:
- `packages/api/src/routes/chat.ts` — `POST /chat` with in-memory `conversationSessions` Map
- `packages/web/src/hooks/useChat.ts` — ephemeral React state for messages
- `packages/web/src/components/chat/ChatPanel.tsx` — chat UI with no session awareness
- `packages/shared/src/types.ts` — `ChatMessage`, `ChatRequest`, WS payload types
- `packages/shared/src/schema.ts` — no chat tables yet

Patterns to follow:
- Schema: `text` PK with `crypto.randomUUID()`, `createdAt`/`updatedAt` with strftime defaults
- Data layer: synchronous Drizzle calls, `findXById`/`listXs`/`createX`/`updateX`/`deleteX` naming
- Routes: Hono router with `zValidator`, JSON responses, 404 for not-found
- Frontend API: `api` object methods with typed returns through shared `request<T>()` wrapper

## Tasks

### Phase 1: Schema & Types (foundation)

#### Task 1: Add chat session and message tables to schema
**Files:** `packages/shared/src/schema.ts`
**Deliverable:** Two new Drizzle tables:
- `chatSessions` — `id` (text PK, UUID), `projectId` (text, not null), `title` (text, default "New Chat"), `agentSessionId` (text, nullable — for Claude SDK multi-turn resume), `createdAt`, `updatedAt`
- `chatMessages` — `id` (text PK, UUID), `sessionId` (text, not null — references chatSessions.id), `role` (text, "user" | "assistant"), `content` (text, not null), `createdAt`
**Logging:** `DEBUG [schema] chatSessions and chatMessages tables defined`
**Export** row types: `ChatSessionRow`, `NewChatSessionRow`, `ChatMessageRow`, `NewChatMessageRow`

#### Task 2: Add chat session TypeScript types
**Files:** `packages/shared/src/types.ts`, `packages/shared/src/browser.ts`
**Deliverable:** New interfaces:
- `ChatSession { id, projectId, title, agentSessionId, createdAt, updatedAt }`
- `CreateChatSessionInput { projectId, title? }`
- `UpdateChatSessionInput { title? }`
- `ChatSessionMessage { id, sessionId, role, content, createdAt }`
**Also:** Export new types from `browser.ts` for frontend use.
**Also:** Update `WsEventType` to add `"chat:session_created"` and `"chat:session_deleted"`.
**Also:** Update `WsEvent.payload` union to include `ChatSession` and `{ id: string }` for session events.
**Logging:** N/A (type definitions only)
**Depends on:** Task 1

### Phase 2: Data Layer

#### Task 3: Add chat session data-access functions
**Files:** `packages/data/src/index.ts`
**Deliverable:** New exported functions following existing patterns:
- `createChatSession(input: { projectId: string; title?: string }) → ChatSessionRow | undefined`
- `findChatSessionById(id: string) → ChatSessionRow | undefined`
- `listChatSessions(projectId: string) → ChatSessionRow[]` (ordered by `updatedAt DESC`)
- `updateChatSession(id: string, fields: { title?: string; agentSessionId?: string | null }) → ChatSessionRow | undefined`
- `deleteChatSession(id: string) → void` (also deletes all related chatMessages)
- `createChatMessage(input: { sessionId: string; role: "user" | "assistant"; content: string }) → ChatMessageRow | undefined`
- `listChatMessages(sessionId: string) → ChatMessageRow[]` (ordered by `createdAt ASC`)
- `updateChatSessionTimestamp(id: string) → void` — touch `updatedAt` on the session (called after each message)
- `toChatSessionResponse(row: ChatSessionRow) → ChatSession` — mapper
**Import** new tables from `@aif/shared` in the data package.
**Logging:** `DEBUG [data] createChatSession projectId=..., title=...` etc. for each function
**Depends on:** Task 1, Task 2

### Phase 3: API Endpoints

#### Task 4: Add chat session REST endpoints
**Files:** `packages/api/src/routes/chat.ts`, `packages/api/src/schemas.ts`
**Deliverable:** Extend `chatRouter` with session sub-routes:
- `GET /chat/sessions?projectId=...` → list sessions for project (newest first)
- `POST /chat/sessions` → create a new session `{ projectId, title? }` → returns `ChatSession`
- `GET /chat/sessions/:id` → get session by ID → returns `ChatSession`
- `GET /chat/sessions/:id/messages` → list messages for session → returns `ChatSessionMessage[]`
- `PUT /chat/sessions/:id` → update session `{ title? }` → returns `ChatSession`
- `DELETE /chat/sessions/:id` → delete session and its messages → 204
**Add** Zod schemas: `createChatSessionSchema`, `updateChatSessionSchema`
**Broadcast** `chat:session_created` and `chat:session_deleted` WS events for real-time UI updates.
**Logging:** `DEBUG [chat-route] GET /chat/sessions projectId=...` etc. for each endpoint
**Depends on:** Task 3

#### Task 5: Persist messages during chat streaming
**Files:** `packages/api/src/routes/chat.ts`
**Deliverable:** Modify the existing `POST /chat` handler:
- Accept optional `sessionId` in request body (add to `ChatRequest` type and `chatRequestSchema`)
- If `sessionId` is provided, use it; if not and `conversationId` maps to a session, use that
- Auto-create a session if `sessionId` is not provided (title defaults to first 80 chars of user message)
- Save user message to `chatMessages` before calling the agent
- Accumulate full assistant response and save to `chatMessages` on `chat:done`
- Store/restore `agentSessionId` from the `chatSessions` table instead of the in-memory Map
- Return `sessionId` in the response JSON alongside `conversationId`
**Remove** the in-memory `conversationSessions` Map — replaced by DB persistence.
**Logging:** `DEBUG [chat-route] Persisting user message sessionId=... messageId=...`, `DEBUG [chat-route] Persisting assistant response sessionId=...`
**Depends on:** Task 3, Task 4

### Phase 4: Frontend

#### Task 6: Add chat session API methods and hook
**Files:** `packages/web/src/lib/api.ts`, `packages/web/src/hooks/useChatSessions.ts` (new)
**Deliverable:**
- Add to `api` object: `listChatSessions(projectId)`, `createChatSession(input)`, `getChatSession(id)`, `getChatSessionMessages(sessionId)`, `updateChatSession(id, input)`, `deleteChatSession(id)`
- Create `useChatSessions(projectId)` hook using `@tanstack/react-query`:
  - `sessions` — list of sessions for the project
  - `activeSessionId` / `setActiveSessionId` — currently selected session
  - `createSession()` — create new session and set as active
  - `deleteSession(id)` — delete and switch to next session or null
  - `renameSession(id, title)` — update title
  - `loadSessionMessages(sessionId)` — fetch messages for a session
- React Query invalidation on `chat:session_created` and `chat:session_deleted` WS events
**Logging:** `console.debug("[useChatSessions] ...")` for state changes
**Depends on:** Task 4

#### Task 7: Update useChat to work with sessions
**Files:** `packages/web/src/hooks/useChat.ts`
**Deliverable:**
- Accept `sessionId: string | null` parameter
- When `sessionId` changes, load messages from API via `api.getChatSessionMessages(sessionId)` and populate state
- Pass `sessionId` to `api.sendChatMessage()` call
- On receiving `chat:done`, messages are already persisted server-side — no client-side save needed
- Keep `clearMessages` for UI reset but also expose `newSession` to create fresh session
- Remove project-change auto-clear (sessions handle this now)
**Logging:** `console.debug("[useChat] Loading session messages sessionId=...")`, `console.debug("[useChat] Session changed, loaded N messages")`
**Depends on:** Task 5, Task 6

#### Task 8: Add session sidebar UI to ChatPanel
**Files:** `packages/web/src/components/chat/ChatPanel.tsx`, `packages/web/src/components/chat/SessionList.tsx` (new)
**Deliverable:**
- Create `SessionList` component — a compact sidebar/dropdown within the chat panel:
  - List of sessions for current project (title + relative time)
  - Active session highlighted
  - Click to switch sessions
  - "New Chat" button at top
  - Swipe-to-delete or delete icon on each session
  - Inline rename (double-click title to edit)
- Integrate into `ChatPanel`:
  - Add a session toggle/drawer button in the header (e.g., a list icon)
  - Show session title in header when a session is active
  - Wire up `useChatSessions` + updated `useChat` hooks
  - Auto-create session on first message if no active session
- Update the `ChatRequest` type usage to include `sessionId`
**Logging:** `console.debug("[ChatPanel] Session switched to ...")`, `console.debug("[SessionList] ...")` for interactions
**Depends on:** Task 6, Task 7

### Phase 5: Testing & Quality

#### Task 9: Add data layer tests for chat sessions
**Files:** `packages/data/src/__tests__/chatSessions.test.ts` (new)
**Deliverable:** Vitest tests covering:
- `createChatSession` — creates session with default title, custom title
- `listChatSessions` — returns sessions for project ordered by updatedAt DESC
- `findChatSessionById` — found and not-found cases
- `updateChatSession` — title update, agentSessionId update
- `deleteChatSession` — deletes session and cascading messages
- `createChatMessage` — creates message linked to session
- `listChatMessages` — returns messages ordered by createdAt ASC
- `updateChatSessionTimestamp` — touches updatedAt
**Logging:** N/A (test file)
**Depends on:** Task 3

#### Task 10: Add API endpoint tests for chat sessions
**Files:** `packages/api/src/__tests__/chatSessions.test.ts` (new)
**Deliverable:** Vitest + Hono test client tests covering:
- `GET /chat/sessions?projectId=...` — returns sessions list
- `POST /chat/sessions` — creates session, returns 201
- `GET /chat/sessions/:id` — found returns session, not-found returns 404
- `GET /chat/sessions/:id/messages` — returns messages list
- `PUT /chat/sessions/:id` — updates title
- `DELETE /chat/sessions/:id` — returns 204, session gone
- Validation errors return 400 with descriptive messages
**Depends on:** Task 4, Task 9

#### Task 11: Add frontend hook tests
**Files:** `packages/web/src/hooks/__tests__/useChatSessions.test.ts` (new)
**Deliverable:** Vitest + React Testing Library tests covering:
- `useChatSessions` — lists sessions, creates session, deletes session, renames session
- `useChat` with session — loads messages on session change, passes sessionId to API
**Depends on:** Task 6, Task 7

### Phase 6: Lint, Build & Docs

#### Task 12: Run linter, fix issues, ensure build passes
**Files:** All modified files
**Deliverable:** `npm run lint` passes. `npm run build` passes. `npm test` passes with ≥70% coverage on new code.
**Logging:** N/A
**Depends on:** Task 8, Task 9, Task 10, Task 11

## Commit Plan

### Commit 1 (after Tasks 1-3): Schema, types, and data layer
```
feat(shared,data): add chat session and message persistence

Add chatSessions and chatMessages tables, TypeScript types, and
data-access functions for persistent chat sessions.
```

### Commit 2 (after Tasks 4-5): API endpoints and streaming persistence
```
feat(api): add chat session REST endpoints and message persistence

Add CRUD routes for chat sessions, persist messages during streaming,
and replace in-memory conversation Map with DB-backed sessions.
```

### Commit 3 (after Tasks 6-8): Frontend session management
```
feat(web): add chat session management UI

Add useChatSessions hook, session list sidebar, session switching,
and wire useChat to load/save messages via persistent sessions.
```

### Commit 4 (after Tasks 9-12): Tests and quality
```
test: add chat session tests for data, API, and frontend layers

Add comprehensive test coverage for chat session CRUD, API endpoints,
and frontend hooks. Run lint and build verification.
```
