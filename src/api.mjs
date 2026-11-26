import { randomBytes } from 'node:crypto';
import { ENDPOINT, HEADER_KEY } from './constants.mjs';
import { HttpError, equalSecret, failure, json, localRequest, readJson } from './http.mjs';

export { ENDPOINT, HEADER_KEY };

export function apiHandler(manager) {
  const key = randomBytes(32).toString('hex');
  let pending = Promise.resolve();
  return async (req, res) => {
    try {
      localRequest(req);
      if (req.method === 'GET') {
        return json(res, 200, { ...await manager.state(), key });
      }
      if (req.method !== 'POST') {
        throw new HttpError(405, '请求方法不受支持');
      }
      if (!equalSecret(req.headers[HEADER_KEY], key)) {
        throw new HttpError(403, '会话校验失效，请刷新页面后重试');
      }
      const input = await readJson(req);
      const task = pending.then(() => manager.action(input));
      pending = task.catch(() => {});
      json(res, 200, await task);
    } catch (error) {
      failure(res, error);
    }
  };
}
