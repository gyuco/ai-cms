import { createServer } from 'node:http';
import { connect } from 'node:net';
import { isAllowed, parseAllowlist, parseConnectTarget } from './allowlist.ts';

// Only HTTPS tunnels (CONNECT) to allowlisted hosts leave the local networks (TECHNICAL §3).
const allowlist = parseAllowlist(process.env.EGRESS_ALLOW ?? '');
const port = Number(process.env.PORT ?? 3128);

const server = createServer((_req, res) => {
  res.writeHead(405, { 'content-type': 'text/plain' });
  res.end('Only CONNECT to allowlisted HTTPS hosts is supported\n');
});

server.on('connect', (req, clientSocket, head) => {
  const target = parseConnectTarget(req.url ?? '');
  if (!target || !isAllowed(target.host, allowlist)) {
    console.warn(`egress: denied ${req.url}`);
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = connect(target.port, target.host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on('error', (error) => {
    console.warn(`egress: upstream error for ${req.url}: ${error.message}`);
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  clientSocket.on('error', close);
});

server.listen(port, () => {
  console.log(`egress: listening on ${port}, allow=${allowlist.join(',') || '(nothing)'}`);
});
