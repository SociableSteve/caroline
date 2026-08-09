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
import { ProjectDetail, Projects } from './surfaces/Projects.js'
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
    staleDays,
    loading,
    failure,
    unfetchedTaskTotal,
    reload,
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
  const onSync = () => void write(() => api.runJob('sync'))
  // These two answer their forms, which keep what was typed until the write lands.
  const onCapture = (input: TaskInput) => write(() => api.createTask(input))
  const onCreateProject = (title: string) => write(() => api.createProject({ title }))
  const onProjectState = (id: string, state: ProjectState) =>
    void write(() => api.patchProject(id, { state }))
  const onDeleteProject = (id: string) => void write(() => api.deleteProject(id))

  const cardHandlers = { onStatusChange, onComplete, onDelete }

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
        {/* The scheduler arrives in M5. Until then this is how a sync happens, and it stays
            afterwards as the manual trigger spec 06 asks be first-class. */}
        <button type="button" onClick={onSync}>
          Sync now
        </button>
        <button type="button" onClick={() => setCapturing(true)}>
          Quick capture
        </button>
      </header>

      <main>
        {failure !== null && (
          <p role="alert" className="failure">
            Cannot reach the server: {failure}{' '}
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
        ) : (
          <Dashboard
            tasks={tasks}
            projects={projects}
            health={health}
            jobRuns={jobRuns}
            staleDays={staleDays}
            now={now}
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
