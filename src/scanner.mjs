import { spawn } from 'node:child_process';

/**
 * Optional local ClamAV scan of an uploaded, private installation package.
 * A scanner error or timeout never means "clean". No shell is used.
 * Neither the uploaded filename nor the HTTP request controls the executable.
 *
 * NOTE: even a clean result is NOT sufficient to publish third-party software.
 * Human review and other product/rights checks are required separately.
 */
export async function scanPackage(filePath, {
  enabled = false,
  command = 'clamscan',
  timeoutMs = 90_000
} = {}) {
  if (!enabled) return { status: 'quarantined', detail: '自动扫描未启用，等待人工复核' };
  if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
    return { status: 'scan_error', detail: '扫描路径无效' };
  }
  return await new Promise(resolve => {
    let done = false;
    let proc;
    let output = '';
    const finish = (status, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve({ status, detail });
    };
    const timeout = setTimeout(() => {
      proc?.kill('SIGKILL');
      finish('scan_error', '扫描超时，禁止发布');
    }, timeoutMs);
    timeout.unref?.();
    try {
      proc = spawn(command, ['--no-summary', '--infected', '--', filePath], {
        shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
      for (const stream of [proc.stdout, proc.stderr]) {
        stream.on('data', chunk => {
          if (output.length < 2000) output += String(chunk).slice(0, 250);
        });
      }
      proc.once('error', () => finish('scan_error', 'ClamAV 未安装或无法启动'));
      proc.once('close', (code, signal) => {
        if (done) return;
        if (signal) return finish('scan_error', '扫描进程异常终止');
        if (code === 0) return finish('scan_passed', 'ClamAV 未发现已知威胁；仍需人工审核');
        if (code === 1) return finish('scan_failed', 'ClamAV 报告存在潜在恶意程序；不得发布');
        return finish('scan_error', 'ClamAV 检测出现错误；禁止发布');
      });
    } catch {
      finish('scan_error', 'ClamAV 执行异常，禁止发布');
    }
  });
}
