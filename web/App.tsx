import { useEffect, useState } from 'react'

interface IntegrationStatus {
  configured: boolean
  status: string
}

interface Health {
  status: string
  version: string
  uptimeSeconds: number
  integrations: Record<string, IntegrationStatus>
}

const integrationNames: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  llm: 'LLM provider',
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch('/api/health')
      .then((response) => {
        if (!response.ok) throw new Error(`health check returned ${response.status}`)
        return response.json() as Promise<Health>
      })
      .then((body) => {
        if (!cancelled) setHealth(body)
      })
      .catch((error: Error) => {
        if (!cancelled) setFailure(error.message)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main>
      <h1>Caroline</h1>
      {failure !== null && <p role="alert">Cannot reach the server: {failure}</p>}
      {health !== null && (
        <>
          <p>
            Version {health.version}, up for {health.uptimeSeconds}s.
          </p>
          <h2>Integrations</h2>
          <ul className="integration-list">
            {Object.entries(health.integrations).map(([key, integration]) => (
              <li key={key}>
                <span>{integrationNames[key] ?? key}</span>
                <span>{integration.status}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}
