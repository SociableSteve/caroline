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
  const { tasks, projects, health, staleDays, loading, failure, reload } = useCarolineData()
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

  /** Every write goes through here: do it, refresh, and say so if it failed. */
  const write = useCallback(
    async (work: () => Promise<unknown>) => {
      try {
        await work()
        setWriteFailure(null)
        setNow(Date.now())
        await reload()
      } catch (error) {
        setWriteFailure(error instanceof Error ? error.message : 'That did not work')
      }
    },
    [reload],
  )

  const onStatusChange = (id: string, status: TaskStatus) =>
    void write(() => api.patchTask(id, { status }))
  const onComplete = (id: string) => void write(() => api.completeTask(id))
  const onDelete = (id: string) => void write(() => api.deleteTask(id))
  const onCapture = (input: TaskInput) => void write(() => api.createTask(input))
  const onCreateProject = (title: string) => void write(() => api.createProject({ title }))
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

        {loading ? (
          <p>Loading.</p>
        ) : route.name === 'board' ? (
          <Board
            tasks={tasks}
            projects={projects}
            staleDays={staleDays}
            now={now}
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
