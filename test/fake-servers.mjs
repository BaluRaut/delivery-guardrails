// Small stand-ins for the GitHub API and a Slack webhook, for tests.
import { createServer } from 'node:http'

/** Serves `routes` ({ 'GET /path': data | (req, body) => data }); arrays are paged by ?per_page. */
export async function fakeServer(routes) {
  const calls = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const url = new URL(req.url, 'http://x')
    calls.push({ method: req.method, path: url.pathname, query: url.search, body: body ? JSON.parse(body) : null })
    const handler = routes[`${req.method} ${url.pathname}`]
    if (handler === undefined) { res.writeHead(404); return res.end(`no route for ${req.method} ${url.pathname}`) }
    let data = typeof handler === 'function' ? handler(url, body ? JSON.parse(body) : null) : handler
    if (data && data.status && data.text !== undefined) { res.writeHead(data.status); return res.end(data.text) }
    const headers = { 'content-type': 'application/json' }
    if (Array.isArray(data)) {
      const perPage = Number(url.searchParams.get('per_page') || 30)
      const page = Number(url.searchParams.get('page') || 1)
      if (data.length > page * perPage) {
        const next = new URL(url); next.searchParams.set('page', page + 1)
        headers.link = `<http://127.0.0.1:${server.address().port}${next.pathname}${next.search}>; rel="next"`
      }
      data = data.slice((page - 1) * perPage, page * perPage)
    }
    res.writeHead(200, headers)
    res.end(JSON.stringify(data))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) }
}
