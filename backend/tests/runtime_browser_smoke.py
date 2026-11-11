"""Explicit Docker acceptance; only an owned test broker receives the socket."""

import asyncio
import json
from pathlib import Path
from uuid import uuid4

from sabre.browser_contracts import BrowserJob, BrowserPreview
from sabre.executor import DockerBroker, snapshot_digest
from sabre.models import DomainError, Project

SERVER = '''from http.server import HTTPServer,BaseHTTPRequestHandler
import os,pathlib
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  good=self.path=='/'
  data=pathlib.Path('/workspace/index.html').read_bytes() if good else b'<!doctype html><html lang="en"><title>Missing</title><main><h1>Missing route</h1></main></html>'
  self.send_response(200 if good else 404);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(data)
 def log_message(self,*args):pass
assert not os.path.exists('/var/run/docker.sock') and not os.path.exists('/run/secrets')
assert not any(k in os.environ for k in ['OPENAI_API_KEY','SABRE_EXECUTOR_TOKEN','SABRE_AUTH_TOKEN'])
HTTPServer(('0.0.0.0',3030),Handler).serve_forever()
'''
HTML = '''<!doctype html><html lang="en"><head><title>Synthetic browser fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;color:#111;background:#fff}main{max-width:40rem}button{padding:1rem}.wide{width:2200px}</style></head><body><main><h1>Synthetic fixture</h1><label for="name">Name</label><input id="name"><button onclick="document.getElementById('feedback').textContent='Saved'">Save</button><p role="status" id="feedback"></p><div CLASS_MARKER>Fixture content</div></main></body></html>'''


async def main():
    broker = DockerBroker(Path('/tmp/sabre-browser-acceptance'))  # noqa: S108 - owned test broker
    work_id = 'browser-acceptance-' + str(uuid4())
    secondary_id = 'browser-acceptance-' + str(uuid4())
    project = Project(name='Synthetic browser fixture', repository='https://github.com/fixture/browser', profile='python',
        gate_commands=[['python', '-m', 'unittest']], browser_preview=BrowserPreview(command=['python', '-I', '-S', 'server.py'], port=3030, synthetic_data=True))
    files = [{'path': path, 'content': content, 'encoding': 'utf-8', 'executable': False}
        for path, content in [('server.py', SERVER), ('index.html', HTML.replace('CLASS_MARKER', 'class="wide"'))]]
    initial = {'files': files, 'digest': snapshot_digest(files)}
    broker._install_snapshot(work_id, initial)
    try:
        await broker._persist_workspace(work_id)
        broker._atomic_json(broker._metadata_path(work_id), {'project': project.model_dump(mode='json'), 'base_commit': 'a' * 40})
        broker.restored.add(work_id)
        red_job = BrowserJob(idempotency_key='synthetic-browser-red', snapshot_digest=initial['digest'],
            operations=[{'action': 'navigate', 'target': '/'}, {'action': 'navigate', 'target': '/missing'}], accessibility=False)
        red = await broker.browser_runner.run(work_id, red_job)
        assert not red['passed'] and all(item['overflow'] for item in red['results'])
        assert all(any(item.get('error') == 'ROUTE_FAILED' for item in viewport['operations']) for viewport in red['results'])
        assert len([item for item in red['artifacts'] if item['kind'] == 'screenshot']) >= 4
        await broker.write_file(work_id, 'index.html', HTML.replace('CLASS_MARKER', ''))
        snapshot = await broker.snapshot(work_id)
        operations = [{'action': 'navigate', 'target': '/'}, {'action': 'fill', 'target': 'Name', 'value': 'Synthetic'},
            {'action': 'press', 'value': 'Tab'}, {'action': 'expect_focus', 'role': 'button', 'target': 'Save'},
            {'action': 'click', 'role': 'button', 'target': 'Save'}, {'action': 'expect_text', 'target': 'Saved'}]
        green_job = BrowserJob(idempotency_key='synthetic-browser-green', snapshot_digest=snapshot['digest'], operations=operations)
        green = await broker.browser_runner.run(work_id, green_job)
        assert green['passed'], green['results']
        assert green['visual_review'] == 'unavailable'
        # Different registered profiles may use the same port without sharing a
        # network, source volume, browser context or fixtures.
        node_server = "import http from 'node:http';import fs from 'node:fs';if(fs.existsSync('/run/secrets')||fs.existsSync('/var/run/docker.sock'))process.exit(2);http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(fs.readFileSync('/workspace/index.html'))}).listen(3030,'0.0.0.0');"
        secondary_project = project.model_copy(update={'profile': 'node', 'browser_preview': BrowserPreview(command=['node', 'server.mjs'], port=3030, synthetic_data=True)})
        secondary_files = [{'path': path, 'content': content, 'encoding': 'utf-8', 'executable': False}
            for path, content in [('server.mjs', node_server), ('index.html', HTML.replace('CLASS_MARKER', '').replace('Synthetic fixture', 'Secondary fixture'))]]
        secondary_snapshot = {'files': secondary_files, 'digest': snapshot_digest(secondary_files)}
        broker._install_snapshot(secondary_id, secondary_snapshot)
        await broker._persist_workspace(secondary_id)
        broker._atomic_json(broker._metadata_path(secondary_id), {'project': secondary_project.model_dump(mode='json'), 'base_commit': 'b' * 40})
        broker.restored.add(secondary_id)
        parallel_job = BrowserJob(idempotency_key='synthetic-concurrent-python', snapshot_digest=snapshot['digest'], viewports=['mobile'],
            operations=[{'action': 'navigate', 'target': '/'}, {'action': 'expect_text', 'target': 'Synthetic fixture'}], accessibility=False, trace=False)
        secondary_job = BrowserJob(idempotency_key='synthetic-concurrent-node', snapshot_digest=secondary_snapshot['digest'], viewports=['desktop'],
            operations=[{'action': 'navigate', 'target': '/'}, {'action': 'expect_text', 'target': 'Secondary fixture'}], accessibility=False, trace=False)
        parallel = await asyncio.gather(broker.browser_runner.run(work_id, parallel_job), broker.browser_runner.run(secondary_id, secondary_job))
        assert all(report['passed'] for report in parallel), [report['results'] for report in parallel]
        restarted = DockerBroker(broker.root)
        assert (await restarted.browser_runner.run(work_id, green_job)) == green
        try:
            await restarted.browser_runner.run(work_id, red_job)
        except DomainError as error:
            assert error.code == 'BROWSER_SOURCE_STALE'
        else:
            raise AssertionError('Stale screenshots were accepted')
        denied_job = BrowserJob(idempotency_key='synthetic-browser-denied', snapshot_digest=snapshot['digest'],
            operations=[{'action': 'navigate', 'target': 'https://example.com'}], accessibility=False, trace=False)
        denied = await restarted.browser_runner.run(work_id, denied_job)
        assert not denied['passed'] and denied['results'][0]['operations'][0]['error'] == 'NAVIGATION_DENIED'
        # Cancellation interrupts the browser process and releases only this run's resources.
        slow_job = BrowserJob(idempotency_key='synthetic-browser-cancel', snapshot_digest=snapshot['digest'],
            operations=[{'action': 'navigate', 'target': '/'}] + [{'action': 'expect_text', 'target': 'Missing synthetic content'}] * 10,
            accessibility=False, trace=False)
        task = asyncio.create_task(restarted.browser_runner.run(work_id, slow_job))
        for _ in range(100):
            if work_id in restarted.browser_runner.running:
                restarted.browser_runner.cancel(work_id)
                break
            await asyncio.sleep(0.1)
        try:
            await task
        except DomainError as error:
            assert error.code == 'BROWSER_JOB_CANCELLED'
        else:
            raise AssertionError('Cancellation did not interrupt the browser job')
        assert not broker.docker.networks.list(filters={'label': ['sabre.kind=browser-qa', f'sabre.work_id={work_id}']})
        assert not broker.docker.containers.list(all=True, filters={'label': ['sabre.kind=browser-qa', f'sabre.work_id={work_id}']})
        print(json.dumps({'negative_overflow_route': True, 'desktop_mobile_fixed': green['passed'], 'keyboard_focus': True,
            'accessibility_evaluator': green['evaluator'], 'screenshots': len([a for a in green['artifacts'] if a['kind'] == 'screenshot']),
            'trace_quarantined': all(a['review_required'] for a in green['artifacts'] if a['kind'] == 'trace'),
            'restart_receipt': True, 'stale_source_denied': True, 'external_navigation_denied': True, 'cancellation': True,
            'node_python_concurrent_isolation': True, 'cleanup': True, 'visual_review': 'unavailable'}))
    finally:
        await broker.cleanup(work_id)
        await broker.cleanup(secondary_id)
        for path in broker.root.glob(f'{work_id}.browser-*.json'):
            path.unlink()


if __name__ == '__main__':
    asyncio.run(main())
