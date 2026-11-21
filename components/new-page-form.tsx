export function NewPageForm({
  action,
}: {
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <form
      action={action}
      className="mt-12 flex flex-col items-start gap-3 sm:flex-row sm:items-end"
    >
      <label className="block w-full max-w-md">
        <span className="text-xs font-medium uppercase tracking-[0.14em] text-ink-soft">
          Title
        </span>
        <input
          name="title"
          type="text"
          className="mt-2 w-full border border-rule bg-paper px-3 py-2 text-ink focus:border-ink focus:outline-none"
        />
      </label>
      <button type="submit" className="border border-ink bg-ink px-4 py-2 text-sm text-paper">
        New page
      </button>
    </form>
  );
}
