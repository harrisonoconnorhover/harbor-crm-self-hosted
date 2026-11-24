import {createServer, request as forward} from 'node:http';

const chooser = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Try Harbor locally</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f8f7;color:#193c3d;font:1rem/1.5 system-ui,sans-serif}header,main{max-width:58rem;margin:auto;padding:2rem}
header{font-size:1.45rem;font-weight:750;color:#00696c}main{padding-top:clamp(2rem,9vh,6rem)}
h1{font-size:clamp(2.2rem,6vw,3.9rem);letter-spacing:-.055em;line-height:1.06;margin:0 0 1rem}p{max-width:42rem}
.roles{display:flex;flex-wrap:wrap;gap:.75rem;margin:2rem 0}button{padding:.8rem 1.2rem;border:1px solid #006568;border-radius:.55rem;background:white;color:#00575a;cursor:pointer;font:inherit;font-weight:650}
.roles form:first-child button{background:#006568;color:white}button:focus-visible{outline:3px solid #e99c54;outline-offset:3px}small{display:block;color:#50686a}</style>
<header>⚓ Harbor</header><main><h1>Explore the sales pipeline</h1>
<p>Open the North Pier spring order as Alex, its sales rep. Read the latest note and complete the delivery follow-up. Then return here as Morgan, the manager, to see who finished it.</p>
<div class="roles"><form method="post" action="/demo/rep"><button>Try as a sales rep</button></form>
<form method="post" action="/demo/manager"><button>Try as the manager</button></form></div>
<small>Fictional workspace on this computer. Return to <strong>/demo</strong> to switch roles. Stopping the demo discards your changes.</small></main></html>`;

export function serveDemo({origin, port, roles, session, workspaceId}) {
  const host = new URL(origin).host;
  const cookie = 'harbor-evaluator-' + port;
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control','no-store');
    res.setHeader('x-frame-options','DENY');
    const end = (status, body = '') => { res.writeHead(status); res.end(body); };
    const redirect = path => { res.setHeader('location',path); end(303); };
    try {
      if (req.headers.host !== host) return end(421);
      const path = req.url?.split('?')[0];
      if (req.method === 'GET' && path === '/demo/ready') return end(200, 'ready');
      if (req.method === 'GET' && (path === '/demo' || path === '/auth/sign-in')) {
        res.setHeader('content-type','text/html; charset=utf-8');
        res.setHeader('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
        return end(200, chooser);
      }
      if (path === '/demo/rep' || path === '/demo/manager') {
        if (req.method !== 'POST' || req.headers.origin !== origin) return end(403);
        const isRep = path === '/demo/rep';
        const token = await session(isRep ? roles.rep : roles.manager);
        res.setHeader('set-cookie',cookie + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
        return redirect('/?kind=deals&view=board' + (isRep ? '&workspaceId=' + workspaceId : ''));
      }
      // Only forward this demo's cookie. Local Harbor installations on other
      // ports may have their own sessions under the same browser hostname.
      const token = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(cookie + '='))?.slice(cookie.length + 1);
      if (req.method === 'GET' && path === '/' && !token) return redirect('/demo');
      if (path?.startsWith('/auth/') && !['/auth/logout','/auth/sign-out'].includes(path)) return redirect('/demo');
      const headers = {...req.headers, cookie: token ? 'harbor-session=' + token : ''};
      delete headers['x-forwarded-host'];
      delete headers['x-forwarded-proto'];
      const upstream = forward({hostname:'127.0.0.1', port, method:req.method, path:req.url, headers}, response => {
        const outgoing = {...response.headers};
        delete outgoing['set-cookie'];
        if (path === '/auth/logout' && response.statusCode === 303) outgoing['set-cookie'] = cookie + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
        res.writeHead(response.statusCode, outgoing);
        response.pipe(res);
        response.once('error', () => res.destroy());
      });
      upstream.once('error', () => { if (!res.headersSent) end(502); else res.destroy(); });
      req.on('aborted', () => upstream.destroy());
      req.pipe(upstream);
    } catch (error) {
      console.error('Demo request failed:', error.message);
      if (!res.headersSent) end(500); else res.destroy();
    }
  });
  server.listen(8788, '0.0.0.0', () => console.log('Harbor demo ready at ' + origin + '/demo'));
}
