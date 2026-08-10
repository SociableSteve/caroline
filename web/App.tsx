/**
 * The shell: navigation between the surfaces, quick capture from anywhere, and the one place
 * writes are turned into API calls. The surfaces themselves take data and callbacks, so they
 * can be driven in a test without a server.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type ProjectState, type TaskInput, type TaskStatus } from './api.js'
import { useCarolineData } from './data.js'
import { routeLinks, useRoute } from './router.js'
import { Board } from './surfaces/Board.js'
import { Dashboard } from './surfaces/Dashboard.js'
import { Jobs } from './surfaces/Jobs.js'
import { ProjectDetail, Projects } from './surfaces/Projects.js'
import { Settings } from './surfaces/Settings.js'
import { QuickCapture } from './components/QuickCapture.js'

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

export function App() {
  const {
    tasks,
    projects,
    health,
    jobRuns,
    jobStatus,
    plan,
    planHistory,
    planDate,
    calendar,
    google,
    preview,
    staleDays,
    loading,
    failure,
    unfetchedTaskTotal,
    reload,
    reloadSettings,
  } = useCarolineData()
  const route = useRoute()
  const [capturing, setCapturing] = useState(false)
  const [writeFailure, setWriteFailure] = useState<string | null>(null)
  // The clock the surfaces measure ages against. Held in state so that a render caused by
  // something else does not silently shift every age on the screen.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(tick)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'c' && !isTyping(event.target) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        setCapturing(true)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * Every write goes through here: do it, refresh, and say so if it failed. It reports whether
   * the write landed, because a form that clears itself on a rejected request has thrown away
   * what the user typed, and the message alone does not give it back.
   */
  const write = useCallback(
    async (work: () => Promise<unknown>): Promise<boolean> => {
      try {
        await work()
      } catch (error) {
        setWriteFailure(error instanceof Error ? error.message : 'That did not work')
        return false
      }

      setWriteFailure(null)
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

  const onStatusChange = (id: string, status: TaskStatus) =>
    void write(() => api.patchTask(id, { status }))
  const onComplete = (id: string) => void write(() => api.completeTask(id))
  const onDelete = (id: string) => void write(() => api.deleteTask(id))
  const onMarkReviewed = (id: string) => void write(() => api.markReviewed(id))
  const onAcceptProposal = (id: string) => void write(() => api.acceptProposal(id))
  const onDismissProposal = (id: string) => void write(() => api.dismissProposal(id))
  const onSync = () => void write(() => api.runJob('sync'))
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
  const onCapture = (input: TaskInput) => write(() => api.createTask(input))
  const onCreateProject = (title: string) => write(() => api.createProject({ title }))
  const onProjectState = (id: string, state: ProjectState) =>
    void write(() => api.patchProject(id, { state }))
  const onDeleteProject = (id: string) => void write(() => api.deleteProject(id))

  const cardHandlers = { onStatusChange, onComplete, onDelete }

  /**
   * The settings answers are read when Settings is opened rather than on every load: the payload
   * preview fetches a Gmail thread, and doing that behind the board would be a request nobody asked
   * for. Re-read after connecting or disconnecting, which is the one thing that changes them.
   */
  useEffect(() => {
    if (route.name === 'settings') void reloadSettings()
  }, [route.name, reloadSettings])

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

  return (
    <>
      <header className="app-header">
        <h1>Caroline</h1>
        <nav aria-label="Surfaces">
          <ul>
            {routeLinks.map((link) => (
              <li key={link.name}>
                <a href={link.href} aria-current={route.name === link.name ? 'page' : undefined}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {/* The scheduler runs sync on its own; this is the manual trigger spec 06 asks be
            first-class, for when you know something has just landed. */}
        <button type="button" onClick={onSync}>
          Sync now
        </button>
        <button type="button" onClick={() => setCapturing(true)}>
          Quick capture
        </button>
      </header>

      <main>
        {/* The message carries its own context, because the two cases read differently: the
            whole board being unreachable, and one panel of it that could not be read while the
            rest of the screen is current. */}
        {failure !== null && (
          <p role="alert" className="failure">
            {failure}{' '}
            <button type="button" onClick={() => void reload()}>
              Try again
            </button>
          </p>
        )}

        {writeFailure !== null && (
          <p role="alert" className="failure">
            {writeFailure}
          </p>
        )}

        {/* Said out loud rather than left to be noticed: a screen showing a subset of the
            tasks and not saying so is worse than one that admits it. */}
        {unfetchedTaskTotal !== null && (
          <p role="status" className="failure">
            Showing {tasks.length} of {unfetchedTaskTotal} tasks. Complete or delete some, or narrow
            what you are looking at.
          </p>
        )}

        {loading ? (
          <p>Loading.</p>
        ) : route.name === 'board' ? (
          <Board
            tasks={tasks}
            projects={projects}
            staleDays={staleDays}
            now={now}
            onMarkReviewed={onMarkReviewed}
            onAcceptProposal={onAcceptProposal}
            onDismissProposal={onDismissProposal}
            {...cardHandlers}
          />
        ) : route.name === 'projects' ? (
          <Projects
            projects={projects}
            onCreate={onCreateProject}
            onStateChange={onProjectState}
            onDelete={onDeleteProject}
          />
        ) : route.name === 'project' ? (
          <ProjectDetail
            project={projects.find((project) => project.id === route.id)}
            tasks={tasks.filter((task) => task.projectId === route.id)}
            staleDays={staleDays}
            now={now}
            {...cardHandlers}
          />
        ) : route.name === 'jobs' ? (
          <Jobs jobs={jobStatus} runs={jobRuns} now={now} onRun={onRunJob} />
        ) : route.name === 'settings' ? (
          <Settings
            google={google}
            preview={preview}
            googleOutcome={route.outcome}
            onConnectGoogle={onConnectGoogle}
            onDisconnectGoogle={onDisconnectGoogle}
            onRefreshPreview={() => void reloadSettings()}
          />
        ) : (
          <Dashboard
            tasks={tasks}
            projects={projects}
            health={health}
            jobRuns={jobRuns}
            plan={plan}
            history={planHistory}
            calendar={calendar}
            staleDays={staleDays}
            now={now}
            onRegeneratePlan={onRegeneratePlan}
            regenerating={regenerating}
            onComplete={onComplete}
          />
        )}
      </main>

      <QuickCapture
        open={capturing}
        projects={projects}
        onClose={() => setCapturing(false)}
        onCreate={onCapture}
      />
    </>
  )
}
