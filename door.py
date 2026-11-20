"""The agent door: one local interface through which any AI agent can work with the user in Scriptorium.

Scriptorium does not run or log in to any model. The user's own agent (Claude Code, Codex, Cursor, a script around a
local model, ...) connects here, either over MCP (Model Context Protocol, streamable HTTP at /mcp) or over plain HTTP
(/agent/...). Both need the door token, which the Assistant panel shows. Through the door an agent can:

  - see what the user is looking at (open file, cursor, selection, compile errors),
  - wait for the user's messages from the Assistant panel, and answer there,
  - edit files, each edit shown to the user as a change they can keep or undo,
  - compile the document, and point the user at a place in it.
"""
import json
import secrets
import threading
import time
import uuid

PROTOCOLS = ('2025-06-18', '2025-03-26', '2024-11-05')
WAIT_DEFAULT, WAIT_MAX = 55, 600  # some MCP clients time out tool calls after a minute


class Door:
    def __init__(self, token_file):
        try:
            self.token = token_file.read_text().strip()
        except OSError:
            self.token = ''
        if len(self.token) < 16:
            self.token = secrets.token_urlsafe(18)
            try:
                token_file.parent.mkdir(parents=True, exist_ok=True)
                token_file.write_text(self.token)
                token_file.chmod(0o600)
            except OSError:
                pass
        self.cv = threading.Condition()
        self.events = []       # for the browser: {id, type, ...}
        self.next_id = 1
        self.chat = []         # the conversation as the panel shows it
        self.inbox = []        # user messages no agent has picked up yet
        self.context = {}      # what the user is looking at, pushed by the page
        self.compile_result = None
        self.agents = {}       # name -> {seen, waiting, status}
        self.sessions = {}     # MCP session id -> agent name

    # -- events for the page -------------------------------------------------------------
    def _push(self, ev):
        ev['id'] = self.next_id
        ev['time'] = time.time()
        self.next_id += 1
        self.events.append(ev)
        del self.events[:-400]
        self.cv.notify_all()
        return ev

    def push(self, **ev):
        with self.cv:
            return self._push(ev)

    def wait_events(self, since, timeout):
        end = time.time() + timeout
        with self.cv:
            while not any(e['id'] > since for e in self.events):
                left = end - time.time()
                if left <= 0:
                    break
                self.cv.wait(left)
            return [e for e in self.events if e['id'] > since], self.presence()

    def presence(self):
        now = time.time()
        return [dict(name=n, waiting=a['waiting'] > 0, status=a['status'], seen=round(now - a['seen']))
                for n, a in self.agents.items() if a['waiting'] > 0 or now - a['seen'] < 180]

    def _seen(self, name, waiting=0, status=None):
        a = self.agents.setdefault(name, dict(seen=0, waiting=0, status=''))
        new = a['seen'] == 0 or time.time() - a['seen'] > 180
        a['seen'] = time.time()
        a['waiting'] += waiting
        if status is not None:
            a['status'] = status
        self._push(dict(type='presence', agents=self.presence(), joined=name if new else None))

    # -- the conversation ----------------------------------------------------------------
    def history(self):
        with self.cv:
            return list(self.chat), self.presence(), self.next_id - 1

    def user_says(self, text, context):
        with self.cv:
            msg = dict(mid=uuid.uuid4().hex[:10], role='user', text=text, context=context or {}, time=time.time())
            self.chat.append(msg)
            self.inbox.append(msg)
            self._push(dict(type='chat', message=msg))
            return msg

    def agent_says(self, name, text, role='agent', **extra):
        with self.cv:
            msg = dict(mid=uuid.uuid4().hex[:10], role=role, agent=name, text=text, time=time.time(), **extra)
            self.chat.append(msg)
            a = self.agents.get(name)
            if a:
                a['status'] = ''
            self._push(dict(type='chat', message=msg))
            self._seen(name)
            return msg

    def clear(self):
        with self.cv:
            self.chat.clear()
            self.inbox.clear()
            self._push(dict(type='cleared'))

    def wait_message(self, name, timeout):
        """The next message from the user, or None after `timeout` seconds."""
        timeout = max(1, min(WAIT_MAX, timeout or WAIT_DEFAULT))
        end = time.time() + timeout
        with self.cv:
            self._seen(name, waiting=1, status='')
            try:
                while not self.inbox:
                    left = end - time.time()
                    if left <= 0:
                        return None
                    self.cv.wait(left)
                msg = self.inbox.pop(0)
                msg['taken_by'] = name
                self._push(dict(type='taken', mid=msg['mid'], agent=name))
                return msg
            finally:
                self._seen(name, waiting=-1)

    def status(self, name, text):
        with self.cv:
            self._seen(name, status=text)


# ---------------------------------------------------------------- the tools, shared by MCP and HTTP

MANUAL = """# Scriptorium agent door

You are connected to Scriptorium, the LaTeX editor the user is writing in, on this computer.
Project folder: {root}
Main file: {main}
All paths are relative to the project folder.

## How to work with the user
1. Call wait_for_message. It returns the user's next message from the Assistant panel, with what they are
   looking at: the open file, the cursor line, the selected text and the compile errors. If it returns no message,
   call it again. Keep doing this until the user says to stop.
2. Do what the message asks. Read files with read_file (or your own tools).
3. Change the document with edit_file: give the exact text to replace and the new text. Every edit shows up in the
   editor as a change the user can keep or undo, so prefer several small edits to rewriting whole files. Keep the
   author's style and do not touch what was not asked for.
4. After editing, compile to check that the document still builds, and fix what you broke.
5. Answer with send_message: short, plain language. Use set_status for "working on it" notes while you work.
6. show_location opens a file at a line in the editor, to point the user at something.
Then call wait_for_message again.
"""

HTTP_MANUAL = """
## Plain HTTP (for agents without MCP)
Send the token with every request: header `X-Scriptorium-Token: {token}` (or `?token={token}`).
Name yourself with the header `X-Scriptorium-Agent: <your name>`.

    curl -s -H "X-Scriptorium-Token: {token}" "{url}/agent/wait?timeout=55"
    curl -s -H "X-Scriptorium-Token: {token}" {url}/agent/context
    curl -s -H "X-Scriptorium-Token: {token}" "{url}/agent/file?path=main.tex"
    curl -s -H "X-Scriptorium-Token: {token}" -X POST {url}/agent/say -d '{{"text": "Done: I shortened the abstract."}}'
    curl -s -H "X-Scriptorium-Token: {token}" -X POST {url}/agent/edit \\
         -d '{{"path": "main.tex", "old_text": "exact old text", "new_text": "new text", "note": "why"}}'
    curl -s -H "X-Scriptorium-Token: {token}" -X POST {url}/agent/compile
    curl -s -H "X-Scriptorium-Token: {token}" -X POST {url}/agent/status -d '{{"text": "Reading the introduction"}}'
    curl -s -H "X-Scriptorium-Token: {token}" -X POST {url}/agent/show -d '{{"path": "main.tex", "line": 42}}'
    curl -s -H "X-Scriptorium-Token: {token}" -X POST {url}/agent/write -d '{{"path": "new.tex", "text": "..."}}'
    curl -s -H "X-Scriptorium-Token: {token}" {url}/agent/files

All answers are JSON. /agent/wait returns {{"message": null}} when nothing came within the timeout: call it again.
"""

TOOLS = [
    dict(name='wait_for_message',
         description='Wait for the next message the user writes in Scriptorium\'s Assistant panel. Returns the text '
                     'and what the user was looking at (open file, cursor line, selection, compile errors). Returns '
                     'no message after the timeout: then call it again.',
         inputSchema=dict(type='object', properties=dict(timeout_seconds=dict(
             type='integer', description=f'How long to wait (default {WAIT_DEFAULT}, at most {WAIT_MAX}).')))),
    dict(name='send_message',
         description='Answer the user in the Assistant panel. Markdown is fine: short paragraphs, lists, `code`.',
         inputSchema=dict(type='object', properties=dict(text=dict(type='string')), required=['text'])),
    dict(name='set_status',
         description='Show a short "working on it" note in the panel, such as "Reading the introduction".',
         inputSchema=dict(type='object', properties=dict(text=dict(type='string')), required=['text'])),
    dict(name='get_context',
         description='What the user is looking at now: open file, cursor line, selected text, open tabs, the last '
                     'compile result, the main file and the project files.',
         inputSchema=dict(type='object', properties={})),
    dict(name='list_files', description='The files of the project.', inputSchema=dict(type='object', properties={})),
    dict(name='read_file',
         description='Read a text file of the project, with line numbers. Optionally only lines first_line..last_line.',
         inputSchema=dict(type='object', properties=dict(path=dict(type='string'), first_line=dict(type='integer'),
                                                         last_line=dict(type='integer')), required=['path'])),
    dict(name='edit_file',
         description='Replace old_text by new_text in a file. old_text must appear exactly once (copy it from the file, '
                     'with enough words to be unique). The user sees the change in the editor and can keep or undo it.',
         inputSchema=dict(type='object', properties=dict(path=dict(type='string'), old_text=dict(type='string'),
                                                         new_text=dict(type='string'),
                                                         note=dict(type='string', description='Why, in a few words.')),
                          required=['path', 'old_text', 'new_text'])),
    dict(name='write_file',
         description='Create a file, or replace a whole file. Prefer edit_file for changes to existing files.',
         inputSchema=dict(type='object', properties=dict(path=dict(type='string'), text=dict(type='string'),
                                                         note=dict(type='string')), required=['path', 'text'])),
    dict(name='compile',
         description='Compile the document now. Returns whether it built, and its errors and warnings with file and line.',
         inputSchema=dict(type='object', properties={})),
    dict(name='show_location',
         description='Open a file at a line in the editor (and show it in the PDF), to point the user at something.',
         inputSchema=dict(type='object', properties=dict(path=dict(type='string'), line=dict(type='integer')),
                          required=['path'])),
]


class ToolError(Exception):
    pass


def compile_summary(r):
    if not r:
        return None
    issues = [i for i in r.get('issues', []) if i.get('kind') in ('error', 'warning')]
    return dict(ok=r.get('ok'), seconds=r.get('seconds'),
                problems=[f"{i['kind']}: {i.get('file') or '?'}:{i.get('line') or '?'}: {i['msg']}" for i in issues[:30]])


def run_tool(door, project, name, args, agent):
    """Run one tool. Returns a JSON-able result, or raises ToolError."""
    P = project()
    if P is None:
        raise ToolError('No project is open in Scriptorium yet. Ask the user to open one.')
    args = args or {}
    if name == 'wait_for_message':
        msg = door.wait_message(agent, int(args.get('timeout_seconds') or args.get('timeout') or WAIT_DEFAULT))
        if not msg:
            return dict(message=None, note='No message yet. Call wait_for_message again.')
        ctx = dict(msg.get('context') or {})
        return dict(message=msg['text'], context=ctx)
    if name == 'send_message':
        text = str(args.get('text', '')).strip()
        if not text:
            raise ToolError('text is empty')
        door.agent_says(agent, text)
        return dict(ok=True)
    if name == 'set_status':
        door.status(agent, str(args.get('text', ''))[:200])
        return dict(ok=True)
    if name == 'get_context':
        c = dict(door.context)
        c.update(project=str(P.root), main=P.main, compile=compile_summary(door.compile_result),
                 files=[f['path'] for f in P.walk() if f['kind'] == 'text'])
        return c
    if name == 'list_files':
        return dict(files=[dict(path=f['path'], kind=f['kind'], size=f.get('size')) for f in P.walk() if f['kind'] != 'dir'])
    if name == 'read_file':
        p = P.safe(args['path'])
        if not p.is_file():
            raise ToolError(f"There is no file {args['path']}")
        lines = p.read_text(encoding='utf-8', errors='replace').split('\n')
        a = max(1, int(args.get('first_line') or 1))
        b = min(len(lines), int(args.get('last_line') or len(lines)))
        width = len(str(b))
        return dict(path=P.rel(p), lines=len(lines),
                    text='\n'.join(f'{n:>{width}}  {lines[n - 1]}' for n in range(a, b + 1)))
    if name in ('edit_file', 'write_file'):
        p = P.safe(args['path'])
        before = p.read_text(encoding='utf-8', errors='replace') if p.is_file() else None
        if name == 'edit_file':
            old, new = args.get('old_text', ''), args.get('new_text', '')
            if before is None:
                raise ToolError(f"There is no file {args['path']}. Use write_file to create it.")
            if not old:
                raise ToolError('old_text is empty')
            n = before.count(old)
            if n == 0:
                raise ToolError('old_text was not found. Read the file again: the user may have changed it.')
            if n > 1:
                raise ToolError(f'old_text appears {n} times. Include more of the surrounding text so it is unique.')
            after = before.replace(old, new, 1)
            line = before[:before.index(old)].count('\n') + 1
        else:
            after = str(args.get('text', ''))
            line = 1
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name('.' + p.name + '.agent')
        tmp.write_text(after, encoding='utf-8')
        tmp.replace(p)
        rel = P.rel(p)
        note = str(args.get('note') or '')[:300]
        door.push(type='edit', path=rel, agent=agent, before=before if before is not None else '', line=line,
                  note=note, created=before is None)
        door.agent_says(agent, ('Created ' if before is None else 'Edited ') + rel + (f' ({note})' if note else ''),
                        role='activity', kind='edit', path=rel, line=line)
        return dict(ok=True, path=rel, line=line, note='The user sees this change in the editor and can keep or undo it.')
    if name == 'compile':
        door.status(agent, 'Compiling')
        r = P.compile()
        door.compile_result = r
        door.push(type='compiled', result=r, agent=agent)
        summary = compile_summary(r)
        errors = sum(1 for x in summary['problems'] if x.startswith('error'))
        door.agent_says(agent, f"Compiled in {r.get('seconds')} s: " + ('it builds' if r.get('ok') else
                        f"{errors} error{'s' if errors != 1 else ''}"), role='activity', kind='compile')
        return summary
    if name == 'show_location':
        path, line = str(args['path']), int(args.get('line') or 1)
        door.push(type='show', path=path, line=line, agent=agent)
        door.agent_says(agent, f'Pointed at {path}, line {line}', role='activity', kind='show', path=path, line=line)
        return dict(ok=True)
    raise ToolError(f'Unknown tool {name}')


# ---------------------------------------------------------------- MCP over streamable HTTP (JSON responses)

def mcp_handle(door, project, body, session, manual):
    """Handle one JSON-RPC message or a batch. Returns (response or None, headers)."""
    headers = {}
    if isinstance(body, list):
        out = [r for r in (mcp_one(door, project, m, session, manual, headers) for m in body) if r is not None]
        return (out or None), headers
    return mcp_one(door, project, body, session, manual, headers), headers


def mcp_one(door, project, msg, session, manual, headers):
    if not isinstance(msg, dict):
        return dict(jsonrpc='2.0', id=None, error=dict(code=-32600, message='Invalid request'))
    mid, method, params = msg.get('id'), msg.get('method'), msg.get('params') or {}
    if method is None:                      # a response from the client: nothing to do
        return None
    if mid is None:                         # a notification
        return None
    agent = door.sessions.get(session) or 'agent'
    try:
        if method == 'initialize':
            info = params.get('clientInfo') or {}
            name = str(info.get('name') or 'agent')[:60]
            sid = uuid.uuid4().hex
            door.sessions[sid] = name
            headers['Mcp-Session-Id'] = sid
            asked = params.get('protocolVersion')
            with door.cv:
                door._seen(name)
            return ok(mid, dict(protocolVersion=asked if asked in PROTOCOLS else PROTOCOLS[0],
                                capabilities=dict(tools=dict(listChanged=False)),
                                serverInfo=dict(name='scriptorium', title='Scriptorium', version='1.0'),
                                instructions=manual()))
        if method == 'ping':
            return ok(mid, {})
        if method == 'tools/list':
            return ok(mid, dict(tools=TOOLS))
        if method == 'tools/call':
            name = params.get('name')
            try:
                result = run_tool(door, project, name, params.get('arguments'), agent)
                return ok(mid, dict(content=[dict(type='text', text=json.dumps(result, ensure_ascii=False, indent=1))],
                                    isError=False))
            except ToolError as e:
                return ok(mid, dict(content=[dict(type='text', text=str(e))], isError=True))
            except (KeyError, ValueError, OSError) as e:
                return ok(mid, dict(content=[dict(type='text', text=f'{type(e).__name__}: {e}')], isError=True))
        if method in ('resources/list', 'prompts/list'):
            return ok(mid, {method.split('/')[0]: []})
        return dict(jsonrpc='2.0', id=mid, error=dict(code=-32601, message=f'Method not found: {method}'))
    except Exception as e:  # never let one bad call take the server down
        return dict(jsonrpc='2.0', id=mid, error=dict(code=-32603, message=str(e)))


def ok(mid, result):
    return dict(jsonrpc='2.0', id=mid, result=result)
