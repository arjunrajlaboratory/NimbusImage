// Girder error responses carry their reason in response.data.message
// (axios shape). Fall back to the JS error message for network-level
// failures. Same extraction several components hand-roll — prefer this.
export function extractErrorMessage(error: unknown): string {
  return (
    (error as any)?.response?.data?.message ??
    (error as Error)?.message ??
    String(error)
  );
}
