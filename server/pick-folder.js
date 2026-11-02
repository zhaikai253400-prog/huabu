'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'pick-folder.ps1');
const CS = path.join(__dirname, 'pick-win.cs');
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const TIMEOUT = 5 * 60 * 1000;

// 弹一个 Windows 原生的「选择文件夹」窗口，返回用户选中的绝对路径。
// 取消选择时返回空路径。
//
// 窗口由 pick-folder.ps1 在 STA 线程里弹出，并且挂在一个置顶的隐蔽父窗口上，
// 这样浏览器画布在前台时，选择窗口也会稳稳浮在它上面，不会被压在底层。
function pickFolderDialog(initialDir) {
  let workDir;
  try {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huabu-pick-'));
  } catch {
    workDir = path.join(DATA_DIR, 'pick-tmp');
    try {
      fs.mkdirSync(workDir, { recursive: true });
    } catch {
      return Promise.reject(new Error('临时目录不可用'));
    }
  }

  const resultFile = path.join(workDir, 'chosen.txt');
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    setTimeout(() => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* 临时文件删不掉不影响导出 */
      }
    }, 1500);
  };

  if (!fs.existsSync(SCRIPT) || !fs.existsSync(CS)) {
    cleanup();
    return Promise.reject(new Error('选择窗口的程序文件不见了，请重新安装画布'));
  }

  return new Promise((resolve, reject) => {
    let child;
    let done = false;
    let timer = null;

    const finish = (picked, error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      cleanup();
      if (error) reject(error);
      else resolve({ path: picked || '', cancelled: !picked });
    };

    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          SCRIPT,
          '-InitialDir',
          String(initialDir || ''),
          '-ResultFile',
          resultFile,
        ],
        { windowsHide: true }
      );
    } catch (error) {
      finish('', new Error('打不开选择窗口：' + error.message));
      return;
    }

    let err = '';
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退出就不用管 */
      }
      finish('', null);
    }, TIMEOUT);

    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
      if (err.length > 4000) err = err.slice(-4000);
    });
    child.on('error', (error) => finish('', new Error('打不开选择窗口：' + error.message)));
    child.on('close', () => {
      let picked = '';
      let hasResult = false;
      try {
        picked = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '').trim();
        hasResult = true;
      } catch {
        hasResult = false;
      }
      if (hasResult) {
        finish(picked, null);
        return;
      }
      finish('', new Error(err.trim().slice(0, 200) || '选择窗口没有正常关闭'));
    });
  });
}

module.exports = pickFolderDialog;
