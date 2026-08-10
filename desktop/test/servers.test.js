import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServer, sshTunnelArgs, sshStartArgs } from '../src/core/servers.js';

test('normalizeServer:合法输入补齐默认值', () => {
  const s = normalizeServer({ sshAlias: 'prod-1' });
  assert.deepEqual(s, { id: 'prod-1', name: 'prod-1', sshAlias: 'prod-1', remotePort: 7080, token: '', enabled: true });
});

test('normalizeServer:拒绝注入形态的别名', () => {
  for (const alias of ['-oProxyCommand=evil', '.hidden', 'a b', 'a;b', '', 'a/b', '别名']) {
    assert.throws(() => normalizeServer({ sshAlias: alias }), /别名不合法/, alias);
  }
});

test('normalizeServer:端口越界拒绝', () => {
  assert.throws(() => normalizeServer({ sshAlias: 'x', remotePort: 0 }));
  assert.throws(() => normalizeServer({ sshAlias: 'x', remotePort: 65536 }));
  assert.throws(() => normalizeServer({ sshAlias: 'x', remotePort: 1.5 }));
});

test('sshTunnelArgs:argv 精确匹配,别名前有 --', () => {
  const s = normalizeServer({ sshAlias: 'prod-1', remotePort: 7080 });
  assert.deepEqual(sshTunnelArgs(s, 17081), [
    '-N', '-L', '17081:127.0.0.1:7080',
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '--', 'prod-1',
  ]);
});

test('sshStartArgs:远程一键启动命令', () => {
  const s = normalizeServer({ sshAlias: 'prod-1' });
  assert.deepEqual(sshStartArgs(s), ['-o', 'BatchMode=yes', '--', 'prod-1', 'systemctl --user start cctower']);
});
