/** A successful write stays successful even if its follow-up read fails. */
export async function mutateAndRefresh<T>(write: () => Promise<T>, refresh: () => Promise<unknown>) {
  const value = await write();
  try {
    await refresh();
    return { value, refreshError: undefined };
  } catch (refreshError) {
    return { value, refreshError };
  }
}

/** Validation errors are shown by Form; do not create an unhandled rejection. */
export async function submitDialog<T>(form: { validateFields: () => Promise<T> }, submit: (values: T) => unknown) {
  const values = await form.validateFields().catch(() => undefined);
  if (values !== undefined) await submit(values);
}

/** Keep edited fields while accepting fresh values for the rest of the form. */
export function mergeDraft<T extends object>(previous: T, latest: T, draft: T): T {
  const result = { ...latest };
  for (const key of Object.keys(previous) as Array<keyof T>) if (draft[key] !== previous[key]) result[key] = draft[key];
  return result;
}
