/** An error whose message is safe and useful to show to the person using the app. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
