// Tiny global UI store (evaluation mode).
import { useSyncExternalStore } from 'react';

let evalMode = false;
const subs = new Set<() => void>();
export function setEvalMode(v: boolean) {
  evalMode = v;
  subs.forEach((s) => s());
}
export function useEvalMode(): [boolean, (v: boolean) => void] {
  const v = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => evalMode,
  );
  return [v, setEvalMode];
}
