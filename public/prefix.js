/* 页面挂载路径推导:直连本机是 '',经网关是 '/s/<serverId>'。
   写成浏览器与 Node 双用,是为了让这段容易算错的正则能被单元测试钉住。 */
'use strict';
(function (root) {
  function computePrefix(pathname) {
    // 去掉最后一段(文件名或空的尾斜杠),剩下的就是挂载目录
    return String(pathname || '/').replace(/\/[^/]*$/, '');
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { computePrefix };
  else root.CCW_PREFIX = computePrefix(root.location.pathname);
})(typeof window !== 'undefined' ? window : globalThis);
