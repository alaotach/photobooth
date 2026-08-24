import WorkerUrl from './worker.js?worker&url';

export class RVMWorkerClient {
  constructor(options) {
    this.worker = new Worker(WorkerUrl, { type: 'module' });
    this.pendingRequests = new Map();
    this.reqId = 0;
    this.isReady = false;
    
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.worker.onmessage = (e) => {
      const { type, id, pha, fgr, error } = e.data;
      if (type === 'ready') {
        this.isReady = true;
        this.resolveReady();
      } else if (type === 'error') {
        if (!this.isReady) this.rejectReady(error);
        if (id !== undefined && this.pendingRequests.has(id)) {
          this.pendingRequests.get(id).reject(error);
          this.pendingRequests.delete(id);
        }
      } else if (type === 'result') {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.get(id).resolve({ pha, fgr });
          this.pendingRequests.delete(id);
        }
      }
    };

    this.worker.postMessage({ type: 'init', payload: options });
  }

  async init() {
    return this.readyPromise;
  }

  async segment(bitmap) {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pendingRequests.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'segment', payload: { id, bitmap } }, [bitmap]);
    });
  }

  reset() {
    this.worker.postMessage({ type: 'reset' });
  }

  terminate() {
    this.worker.terminate();
  }
}
