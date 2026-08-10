// ssh 别名白名单:首字符必须是字母数字(挡 -flag 与 .hidden),后续仅 . _ - 与字母数字。
// 这是参数注入的第一道防线,第二道是 argv 里别名前固定加 "--"。
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeServer(input = {}) {
  const sshAlias = String(input.sshAlias || '').trim();
  if (!ALIAS_RE.test(sshAlias)) {
    throw new Error(`ssh 别名不合法:「${sshAlias}」。仅允许字母数字与 . _ -,且首字符必须是字母数字`);
  }
  const remotePort = Number(input.remotePort ?? 7080);
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error(`远端端口不合法:${input.remotePort}`);
  }
  const name = String(input.name || '').trim() || sshAlias;
  return { id: sshAlias, name, sshAlias, remotePort, token: String(input.token || ''), enabled: input.enabled !== false };
}

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

export function sshTunnelArgs(server, localPort) {
  return ['-N', '-L', `${localPort}:127.0.0.1:${server.remotePort}`, ...SSH_OPTS, '--', server.sshAlias];
}

export function sshStartArgs(server) {
  // keepalive 让远端无响应时超时退出而不是无限挂住。
  return ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '--', server.sshAlias, 'systemctl --user start cctower'];
}
