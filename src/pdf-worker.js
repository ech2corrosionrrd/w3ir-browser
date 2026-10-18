'use strict';
// Worker thread for PDF processing: no electron, no UI. One job per worker; the parent enforces timeout and terminates.
const { parentPort } = require('worker_threads');
const tools = require('./pdf-tools');

parentPort.once('message', async (job) => {
  try {
    if (!job || typeof job !== 'object' || !Array.isArray(job.paths) || job.paths.length > tools.MAX_FILES) throw Object.assign(new Error('select'), { code: 'select' });
    if (job.op === 'describe') {
      const r = await tools.describeLocal(job.paths[0]);
      return parentPort.postMessage({ ok: true, result: r });
    }
    const res = await tools.execute(job);
    const transfer = [];
    const outputs = res.outputs.map(o => {
      const u8 = new Uint8Array(o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength));
      transfer.push(u8.buffer);
      return { bytes: u8, pages: o.pages, removedActions: o.removedActions };
    });
    parentPort.postMessage({ ok: true, result: { outputs, name: res.name, base: res.base } }, transfer);
  } catch (e) {
    parentPort.postMessage({ ok: false, code: e && typeof e.code === 'string' ? e.code : 'fail' });
  }
});
