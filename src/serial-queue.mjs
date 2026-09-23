export function createSerialQueue() {
  let tail = Promise.resolve();

  return function enqueue(operation) {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export async function runRepeatedAction(count, intervalMs, action) {
  for (let index = 0; index < count; index += 1) {
    try {
      await action(index);
    } catch (error) {
      if (error instanceof Error) error.repeatIndex = index + 1;
      throw error;
    }
    if (index + 1 < count && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
