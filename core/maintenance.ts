// Process-local gate: updater owns it only during the idle -> quit transition.
// It is intentionally not persisted; an unsuccessful install must not lock out the next launch.
let updatePending = false;
export function isUpdatePending(): boolean { return updatePending; }
export function setUpdatePending(value: boolean): void { updatePending = value; }
export function assertCollectionAvailable(): void {
  if (updatePending) throw new Error("正在准备更新，请在程序重新打开后继续收集");
}
