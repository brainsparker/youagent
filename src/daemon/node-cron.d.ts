declare module 'node-cron' {
  interface ScheduledTask {
    start(): void;
    stop(): void;
  }

  interface ScheduleOptions {
    scheduled?: boolean;
    timezone?: string;
  }

  function schedule(
    expression: string,
    func: () => void | Promise<void>,
    options?: ScheduleOptions,
  ): ScheduledTask;

  function validate(expression: string): boolean;

  export { schedule, validate, ScheduledTask, ScheduleOptions };
  export default { schedule, validate };
}
