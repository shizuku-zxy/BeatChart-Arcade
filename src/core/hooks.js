import { useEffect, useReducer } from 'react';
import { subscribe, getState } from './store.js';

/** 订阅全局 store，任何变更触发重渲染 */
export function useStore() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribe(force), []);
  return getState();
}
