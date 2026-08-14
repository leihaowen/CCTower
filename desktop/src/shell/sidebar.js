// 侧栏折叠。折叠态只留一条状态点轨道:服务器还能点着切,但名称、角标数字与
// "添加服务器"表单让位给内容区。展开态恢复全部。
// 折叠与否存 localStorage,重启后保持——每次开窗都要重新收一遍会很烦。

const KEY = 'ccw:sidebar-collapsed';
const CLASS = 'sidebar-collapsed';

function readPersisted() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false; // storage 被禁用时退回展开态,不影响主流程
  }
}

function persist(collapsed) {
  try {
    localStorage.setItem(KEY, collapsed ? '1' : '0');
  } catch {
    // 存不下只影响下次启动的初始态,不值得打断交互
  }
}

/**
 * 接线折叠按钮。root 上挂 .sidebar-collapsed 类,具体宽度与隐藏规则全在 CSS 里,
 * 这里只管状态与无障碍属性。
 */
export function initSidebar({ root = document.body, toggle }) {
  if (!toggle) throw new Error('侧栏折叠按钮不存在,检查 index.html 的 #sidebar-toggle');

  let collapsed = readPersisted();

  function apply() {
    root.classList.toggle(CLASS, collapsed);
    const label = collapsed ? '展开侧栏' : '收起侧栏';
    toggle.textContent = collapsed ? '»' : '«';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    persist(collapsed);
    apply();
  });

  apply();
  return { isCollapsed: () => collapsed };
}
