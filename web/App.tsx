/**
 * The shell: navigation between the surfaces, the chat rail beside whichever one is showing, quick
 * capture from anywhere, and the one place writes are turned into API calls. The surfaces themselves
 * take data and callbacks, so they can be driven in a test without a server.
 */
import { useCallback, useEffect, useState } from 'react'
import { cn } from './lib/utils.js'
import { sameItem } from '../src/domain/selection.js'
import {
  api,
  type ItemRef,
  type JobStatus,
  type McpConsentView,
  type ProjectState,
  type ProjectView,
  type TaskInput,
  type TaskStatus,
  type TaskView,
} from './api.js'
import { useAuthGate } from './auth.js'
import { useChat } from './chat.js'
import { useCarolineData } from './data.js'
import { ago } from './format.js'
import {
  chatRailHref,
  conversationHref,
  itemHref,
  routeLinks,
  surfaceHref,
  useLocation,
} from './router.js'
import { Board } from './surfaces/Board.js'
import { Dashboard } from './surfaces/Dashboard.js'
import { Jobs } from './surfaces/Jobs.js'
import { ProjectDetail, Projects } from './surfaces/Projects.js'
import { Settings } from './surfaces/Settings.js'
import { AlertBand } from './components/AlertBand.js'
import { ChatRail } from './components/ChatRail.js'
import { DetailsPanel, type DetailsSubject } from './components/DetailsPanel.js'
import { LoginScreen } from './components/LoginScreen.js'
import { QuickCapture } from './components/QuickCapture.js'
import { failureClassName } from './components/primitives.js'
import { Button } from './components/ui/button.js'
import { productName } from './title.js'

/**
 * What the details panel shows for the reference in the hash, or null where it names nothing that is
 * loaded. Resolved from the data the surfaces are already drawing from rather than fetched: a panel
 * that read the item again could show a different task from the card that opened it. Spec 08.
 */
function subjectFor(
  selected: ItemRef | null,
  tasks: readonly TaskView[],
  projects: readonly ProjectView[],
  allTasksLoaded: boolean,
): DetailsSubject | null {
  if (selected === null) return null

  if (selected.kind === 'task') {
    const task = tasks.find((candidate) => candidate.id === selected.id)
    if (task === undefined) return null

    return {
      kind: 'task',
      task,
      projectTitle:
        task.projectId === null
          ? null
          : (projects.find((project) => project.id === task.projectId)?.title ?? null),
    }
  }

  const project = projects.find((candidate) => candidate.id === selected.id)
  if (project === undefined) return null

  return {
    kind: 'project',
    project,
    tasks: tasks.filter((task) => task.projectId === project.id),
    // Whether the client holds every task, so the panel's counts read as totals or as a floor. A
    // filtered subset of a truncated list is still truncated.
    allTasksLoaded,
  }
}

/** A shortcut typed into a field is text, not a command. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

/**
 * What the header says about syncing: that one is going, or how the last one went. Everything but
 * the running flag comes from the scheduler's own run history, so the header and the Jobs surface
 * cannot disagree about a job neither of them owns. It says nothing about when, because this is
 * the sentence the live region carries and it must change when the job does, not when the clock
 * does: `syncAgeMessage` has the age. Spec 08, criteria 50 and 51.
 */
function syncStatusMessage(job: JobStatus | undefined, running: boolean): string {
  if (running) return 'Syncing'
  if (job?.lastRun == null) return ''
  if (job.lastRun.status === 'failure') return 'Sync failed'
  if (job.lastRun.status === 'skipped') return 'Sync skipped'
  return 'Synced'
}

/**
 * How long ago the last sync finished, for the plain element beside the live region. Nothing while
 * one is going, because there is no finished run to date, and nothing before the first one.
 * Spec 08, criterion 51.
 */
function syncAgeMessage(job: JobStatus | undefined, running: boolean, now: number): string {
  if (running || job?.lastRun == null) return ''

  return ago(job.lastRun.finishedAt, now)
}

export function App() {
  const auth = useAuthGate()
  // Not just `auth.authenticated`: that is optimistically `true` until the first status read
  // answers (see the doc comment on `ready` in auth.ts), so gating everything below on `ready`
  // too is what keeps an auth-required deployment from flashing the authenticated shell, and
  // firing the data fetches that go with it, before the first check has actually resolved.
  const authenticated = auth.ready && auth.authenticated
  const {
    tasks,
    projects,
    jobRuns,
    jobStatus,
    spend,
    plan,
    planDate,
    calendar,
    google,
    health,
    preview,
    mcpClients,
    userName,
    staleDays,
    timezone,
    configLoaded,
    loading,
    failure,
    unfetchedTaskTotal,
    reload,
    reloadSettings,
  } = useCarolineData(authenticated)
  const { route, chatOpen: chatInUrl, conversationId, selected, hash } = useLocation()
  const [capturing, setCapturing] = useState(false)
  const [writeFailure, setWriteFailure] = useState<string | null>(null)
  // Quick Capture's own failure, kept separate from `writeFailure`: that state is shared by
  // every other write path, and a capture dialog that read it would show an unrelated failure
  // (completing a task, say) as though the capture itself had just failed. Reset whenever the
  // dialog opens or closes, so a previous attempt's failure never leaks into a fresh one.
  const [captureFailure, setCaptureFailure] = useState<string | null>(null)
  /**
   * Whether the rail is open. Open by default: chat is the thing Caroline is for, and a rail that has
   * to be opened again on every surface you land on is one that ends up unused. Held here as well as
   * in the hash so that a click shows it at once rather than a `hashchange` later, and followed from
   * the hash below, so a reload, a back button and a shared link all agree about it.
   */
  const [chatOpen, setChatOpen] = useState(() => chatInUrl)
  // The clock the surfaces measure ages against. Held in state so that a render caused by
  // something else does not silently shift every age on the screen.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setChatOpen(chatInUrl)
  }, [chatInUrl])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(tick)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'c' && !isTyping(event.target) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        setCaptureFailure(null)
        setCapturing(true)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * Every write goes through here: do it, refresh, and say so if it failed, into whichever
   * failure state the caller names. It reports whether the write landed, because a form that
   * clears itself on a rejected request has thrown away what the user typed, and the message
   * alone does not give it back.
   */
  const runWrite = useCallback(
    async (
      work: () => Promise<unknown>,
      setFailure: (message: string | null) => void,
    ): Promise<boolean> => {
      try {
        await work()
      } catch (error) {
        setFailure(error instanceof Error ? error.message : 'That did not work')
        return false
      }

      setFailure(null)
      setNow(Date.now())

      // The refresh is deliberately outside the result. It happened after the write landed, so
      // a failure here is a stale screen, not a failed write: reporting it as one would have a
      // form offer to retry a create that already succeeded, and the retry would duplicate it.
      // `reload` reports its own failures and does not reject, and this keeps that from being
      // something a caller has to know.
      try {
        await reload()
      } catch {
        // Deliberately ignored: see above.
      }

      return true
    },
    [reload],
  )

  // The shared write path, for every write except Quick Capture: see `captureFailure` above.
  const write = useCallback(
    (work: () => Promise<unknown>) => runWrite(work, setWriteFailure),
    [runWrite],
  )

  const onStatusChange = (id: string, status: TaskStatus) =>
    void write(() => api.patchTask(id, { status }))
  /**
   * Setting, changing or clearing a due date or a defer-until date from a card's "More"
   * disclosure. The same three-state contract as `update_task` from chat: a field named `null`
   * is cleared, and a field left out of the patch is left alone. Issue #44.
   */
  const onDatesChange = (id: string, patch: Partial<Pick<TaskInput, 'dueAt' | 'deferUntil'>>) =>
    void write(() => api.patchTask(id, patch))
  const onComplete = (id: string) => void write(() => api.completeTask(id))
  const onDelete = (id: string) => void write(() => api.deleteTask(id))
  const onMarkReviewed = (id: string) => void write(() => api.markReviewed(id))
  const onUndoStatus = (id: string) => void write(() => api.undoStatus(id))
  const onAcceptProposal = (id: string) => void write(() => api.acceptProposal(id))
  const onDismissProposal = (id: string) => void write(() => api.dismissProposal(id))
  /**
   * Whether a sync is going, and what to say about it. The scheduler is the one authority on that
   * (spec 06), so this reads its answer rather than keeping a second idea of it: a run the schedule
   * started reports here exactly as one this button started, and the change feed announces a run's
   * start as well as its finish so the answer arrives while it is still true.
   *
   * `syncing` covers only the gap between the press and the server's first word, which
   * `POST /api/jobs/sync/run` leaves wide open: it does not answer until the run has finished, so
   * without this the press would show nothing at all for the length of a sync. Spec 08,
   * criteria 49 and 50.
   */
  const [syncing, setSyncing] = useState(false)
  const syncJob = jobStatus.find((job) => job.job === 'sync')
  const syncRunning = syncing || syncJob?.running === true
  const syncFailed = !syncRunning && syncJob?.lastRun?.status === 'failure'
  const syncMessage = syncStatusMessage(syncJob, syncRunning)
  const syncAge = syncAgeMessage(syncJob, syncRunning, now)

  const onSync = () => {
    if (syncRunning) return

    setSyncing(true)
    void write(() => api.runJob('sync')).finally(() => setSyncing(false))
  }
  /**
   * Redrawing today's plan. The date comes from the server's answer rather than from this
   * browser's clock: the two can differ across midnight, and the route only regenerates today.
   *
   * One at a time. The scheduler's overlap guard already refuses a second concurrent run with a
   * 409, so a double click cannot draw two plans or spend two model calls; this is so the
   * second click does not put that 409 on the screen as though something had gone wrong.
   */
  const [regenerating, setRegenerating] = useState(false)

  const onRegeneratePlan = () => {
    if (planDate === null || regenerating) return

    setRegenerating(true)
    void write(() => api.regeneratePlan(planDate)).finally(() => setRegenerating(false))
  }
  const onRunJob = (job: string) => void write(() => api.runJob(job))
  // These two answer their forms, which keep what was typed until the write lands.
  const onCapture = (input: TaskInput) => runWrite(() => api.createTask(input), setCaptureFailure)
  const onCreateProject = (title: string) => write(() => api.createProject({ title }))
  const onProjectState = (id: string, state: ProjectState) =>
    void write(() => api.patchProject(id, { state }))
  const onDeleteProject = (id: string) => void write(() => api.deleteProject(id))

  /**
   * Opening an item, or closing the one that is open by clicking it again. The selection lives in the
   * hash, so a reload and a shared link agree about it, and opening one opens the rail because the
   * panel is inside it. Spec 08.
   */
  const onSelectItem = (item: ItemRef) => {
    const next = sameItem(selected, item) ? null : item
    if (next !== null) setChatOpen(true)

    const href = itemHref(next, window.location.hash)
    if (href !== window.location.hash) window.location.hash = href
  }

  const closeDetails = () => {
    const href = itemHref(null, window.location.hash)
    if (href !== window.location.hash) window.location.hash = href
  }

  const cardHandlers = {
    onStatusChange,
    onComplete,
    onDelete,
    onDatesChange,
    onSelect: onSelectItem,
    selected,
  }

  /**
   * Chat keeps its own state: it is the one part of the UI whose answers arrive in pieces, and the
   * board's one-fetch-serves-everything approach has nothing to offer it. What it shares with the
   * rest of the UI is the reload, because a turn that moved a task has moved it for every other
   * surface too.
   */
  const chat = useChat({
    conversationId,
    // Read at the moment a message is sent, from whatever is selected then. Spec 07, rule 1.
    selected,
    // Nothing chat-shaped is fetched while the login screen (or the loading state before the
    // first status check answers) is showing: the rail is not on screen then either, below.
    active: chatOpen && authenticated,
    onDataChanged: () => void reload(),
    onConversationStarted: (id) => {
      // The surface is kept: a conversation started while reading the board is still about the
      // board, and the URL is what makes it something to come back to.
      window.location.hash = conversationHref(id, window.location.hash)
    },
  })

  /**
   * The settings answers are read when Settings is opened rather than on every load: the payload
   * preview fetches a Gmail thread, and doing that behind the board would be a request nobody asked
   * for. Re-read after connecting, disconnecting or renaming, which is what changes them.
   */
  useEffect(() => {
    if (route.name === 'settings' && authenticated) void reloadSettings()
  }, [route.name, authenticated, reloadSettings])

  const onConnectGoogle = () =>
    void (async () => {
      try {
        const { url } = await api.connectGoogle()
        // Google is opened in this tab: the flow comes back to this server, and the callback
        // redirects to Settings, so the user ends up where they started.
        window.location.assign(url)
      } catch (error) {
        setWriteFailure(error instanceof Error ? error.message : 'That did not work')
      }
    })()

  const onDisconnectGoogle = () =>
    void (async () => {
      if (await write(() => api.disconnectGoogle())) await reloadSettings()
    })()

  /**
   * The name goes to the model on every call, so saving it re-reads the payload preview: the point
   * of that screen is that it shows what would actually be sent, and a stale preview would not.
   */
  const onSaveUserName = async (name: string): Promise<boolean> => {
    const saved = await write(() => api.patchSettings({ userName: name }))
    if (saved) await reloadSettings()
    return saved
  }

  /**
   * The consent screen's own view, read from the request id `GET /api/mcp/authorize` left in the
   * hash. `undefined` while the URL names none; `null` for one that no longer exists (spec 12,
   * criterion 31). Read here rather than in `useCarolineData`, because it is not part of the
   * settings answers the rest of that screen reads: it is a one-time landing rather than a state
   * of the deployment.
   */
  const [mcpConsent, setMcpConsent] = useState<McpConsentView | null | undefined>(undefined)
  const mcpRequestId = route.name === 'settings' ? route.mcpRequest : null

  useEffect(() => {
    if (mcpRequestId === null) {
      setMcpConsent(undefined)
      return
    }
    void api
      .getMcpConsent(mcpRequestId)
      .then(setMcpConsent)
      .catch(() => setMcpConsent(null))
  }, [mcpRequestId])

  const onDecideMcpConsent = (approve: boolean) =>
    void (async () => {
      if (mcpRequestId === null) return
      try {
        const { redirectTo } = await api.decideMcpConsent(mcpRequestId, approve)
        // Sends the browser back to the client's own redirect URI, with a code or a denial: the
        // native client's own loopback listener is what is waiting on the other end of this.
        window.location.assign(redirectTo)
      } catch (error) {
        setWriteFailure(error instanceof Error ? error.message : 'That did not work')
      }
    })()

  const onRevokeMcpClient = (clientId: string) =>
    void (async () => {
      if (await write(() => api.revokeMcpClient(clientId))) await reloadSettings()
    })()

  const setChat = (open: boolean) => {
    setChatOpen(open)
    // And in the URL, which is where the rail's openness really lives. The conversation leaves with
    // it: a hash naming a conversation nobody can see would reopen the rail on the next reload.
    //
    // Compared against the hash as it is now rather than against `chatInUrl`, which lags behind it
    // until `hashchange` fires: opening and closing quickly would otherwise leave the close unwritten
    // and the pending event would reopen the rail.
    const next = chatRailHref(open, window.location.hash)
    if (next !== window.location.hash) window.location.hash = next
  }

  // Neither the authenticated shell nor the login screen until the first status check has
  // actually answered: `auth.authenticated` is optimistically `true` until then (see auth.ts),
  // and rendering the shell on that guess is exactly the flash spec 13 rules out. Nothing here
  // needs to know which surface is coming, so there is nothing to show but a loading state.
  if (!auth.ready) {
    return <p role="status">Loading.</p>
  }

  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-sidebar-border bg-sidebar px-4 py-2">
        {/* Not a heading. The one `h1` on the page belongs to the surface and names it, so that
            every surface has an outline and every entry in history is distinguishable. Spec 10. */}
        <p className="m-0 text-sm font-semibold tracking-tight">{productName}</p>
        <nav aria-label="Surfaces">
          <ul className="m-0 flex flex-wrap gap-0.5 p-0">
            {routeLinks.map((link) => (
              <li key={link.name}>
                {/* The rail travels with the link: changing surface is not closing the companion
                    to the last one, nor abandoning the conversation it was holding. */}
                <a
                  href={surfaceHref(link.href, hash)}
                  aria-current={route.name === link.name ? 'page' : undefined}
                  className="inline-block rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground no-underline hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex flex-wrap gap-2">
          {authenticated && (
            <>
              {/* The scheduler runs sync on its own; this is the manual trigger spec 06 asks be
                  first-class, for when you know something has just landed. A trigger that says
                  nothing when pressed is not first-class, so the state of the run sits beside it,
                  in a live region: the press is acknowledged before the request answers, and the
                  outcome is readable without going to Jobs to find it. The words carry it and the
                  colour only seconds it, per spec 08's rule that colour is never the only carrier.
                  Spec 08, criteria 49, 50 and 51. */}
              <span
                hidden={syncMessage === ''}
                className={cn(
                  'items-center gap-1 self-center text-xs',
                  // Not `flex` while there is nothing to say: an empty element still takes a gap
                  // from the header's own `gap-2`, which on a fresh install is a space before the
                  // button with nothing in it. Spec 08, criterion 51.
                  syncMessage === '' ? undefined : 'flex',
                  syncFailed ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {/* The live region is the state, and only the state. The age is its sibling
                    rather than its content: it is bucketed by the minute against a clock this
                    app re-reads every minute, so inside the region it would announce itself to a
                    screen reader once a minute forever with nothing having happened. Out here it
                    is read when somebody wants it. Spec 08, criterion 51. */}
                <span role="status">{syncMessage}</span>
                {syncAge !== '' && <span>{syncAge}</span>}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={onSync}
                disabled={syncRunning}
              >
                Sync now
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => {
                  setCaptureFailure(null)
                  setCapturing(true)
                }}
              >
                Quick capture
              </Button>
              {/* Chat is a companion to the surface rather than a place to go, so it is a control
                  here rather than a link in the navigation. Spec 08. */}
              <Button
                type="button"
                size="sm"
                className="h-7 px-2.5 text-xs"
                aria-expanded={chatOpen}
                onClick={() => setChat(!chatOpen)}
              >
                Chat
              </Button>
            </>
          )}
          {/* Invisible, and nothing else here changes, where a login is not required: spec 13's
              loopback shape. Where one is, this is the fourth of the flow's four routes and the
              only one this shell offers a control for. */}
          {auth.authRequired && authenticated && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => void auth.logout()}
            >
              Sign out
            </Button>
          )}
        </div>
      </header>

      {!authenticated ? (
        <main>
          <LoginScreen
            providerLabel={auth.providerLabel}
            failure={auth.failure}
            onLogin={() => void auth.login(window.location.hash)}
          />
        </main>
      ) : (
        <>
          {/* Issue #47: only broken or overdue things, capped at three. Expanded on Today; a
              one-line collapsed strip with a count, linking back to Today, everywhere else. */}
          <AlertBand
            jobs={jobStatus}
            tasks={tasks}
            now={now}
            onRunJob={onRunJob}
            onOpenTask={(id) => onSelectItem({ kind: 'task', id })}
            expanded={route.name === 'dashboard'}
            hash={hash}
          />

          <div
            className={cn(
              'grid min-h-0 flex-1 items-stretch self-stretch',
              chatOpen ? 'grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]' : 'grid-cols-1',
            )}
          >
            <main className="min-w-0 overflow-y-auto px-4 py-4 md:px-5 md:pb-12">
              {/* The message carries its own context, because the two cases read differently: the
              whole board being unreachable, and one panel of it that could not be read while the
              rest of the screen is current. */}
              {failure !== null && (
                <p role="alert" className={failureClassName}>
                  {failure}{' '}
                  <Button type="button" onClick={() => void reload()}>
                    Try again
                  </Button>
                </p>
              )}

              {writeFailure !== null && (
                <p role="alert" className={failureClassName}>
                  {writeFailure}
                </p>
              )}

              {/* Said out loud rather than left to be noticed: a screen showing a subset of the
              tasks and not saying so is worse than one that admits it. */}
              {unfetchedTaskTotal !== null && (
                <p role="status" className={failureClassName}>
                  Showing {tasks.length} of {unfetchedTaskTotal} tasks. Complete or delete some, or
                  narrow what you are looking at.
                </p>
              )}

              {loading ? (
                <p>Loading.</p>
              ) : route.name === 'board' ? (
                <Board
                  tasks={tasks}
                  projects={projects}
                  staleDays={staleDays}
                  timezone={timezone}
                  configLoaded={configLoaded}
                  now={now}
                  onMarkReviewed={onMarkReviewed}
                  onAcceptProposal={onAcceptProposal}
                  onDismissProposal={onDismissProposal}
                  onUndoStatus={onUndoStatus}
                  {...cardHandlers}
                />
              ) : route.name === 'projects' ? (
                <Projects
                  projects={projects}
                  selected={selected}
                  hash={hash}
                  onSelect={onSelectItem}
                  onCreate={onCreateProject}
                  onStateChange={onProjectState}
                  onDelete={onDeleteProject}
                />
              ) : route.name === 'project' ? (
                <ProjectDetail
                  project={projects.find((project) => project.id === route.id)}
                  tasks={tasks.filter((task) => task.projectId === route.id)}
                  staleDays={staleDays}
                  timezone={timezone}
                  configLoaded={configLoaded}
                  now={now}
                  hash={hash}
                  {...cardHandlers}
                />
              ) : route.name === 'jobs' ? (
                <Jobs jobs={jobStatus} runs={jobRuns} spend={spend} now={now} onRun={onRunJob} />
              ) : route.name === 'settings' ? (
                <Settings
                  google={google}
                  health={health}
                  preview={preview}
                  userName={userName}
                  googleOutcome={route.outcome}
                  onConnectGoogle={onConnectGoogle}
                  onDisconnectGoogle={onDisconnectGoogle}
                  onRefreshPreview={() => void reloadSettings()}
                  onSaveUserName={onSaveUserName}
                  mcpClients={mcpClients}
                  onRevokeMcpClient={onRevokeMcpClient}
                  mcpConsent={mcpConsent}
                  onDecideMcpConsent={onDecideMcpConsent}
                />
              ) : (
                <Dashboard
                  tasks={tasks}
                  projects={projects}
                  plan={plan}
                  calendar={calendar}
                  staleDays={staleDays}
                  now={now}
                  onRegeneratePlan={onRegeneratePlan}
                  regenerating={regenerating}
                  onComplete={onComplete}
                  onSelect={onSelectItem}
                  selected={selected}
                  hash={hash}
                />
              )}
            </main>

            {chatOpen && (
              <ChatRail
                details={
                  selected === null ? null : (
                    <DetailsPanel
                      item={selected}
                      subject={subjectFor(selected, tasks, projects, unfetchedTaskTotal === null)}
                      staleDays={staleDays}
                      now={now}
                      onClose={closeDetails}
                    />
                  )
                }
                status={chat.status}
                conversations={chat.conversations}
                conversation={chat.conversation}
                messages={chat.messages}
                draft={chat.draft}
                sending={chat.sending}
                failure={chat.failure}
                now={now}
                hash={hash}
                onSend={chat.send}
                onConfirm={chat.confirm}
                onUndo={chat.undo}
                onClose={() => setChat(false)}
              />
            )}
          </div>
        </>
      )}

      <QuickCapture
        open={capturing}
        projects={projects}
        timezone={timezone}
        configLoaded={configLoaded}
        failure={captureFailure}
        onClose={() => {
          setCapturing(false)
          setCaptureFailure(null)
        }}
        onCreate={onCapture}
      />
    </>
  )
}
