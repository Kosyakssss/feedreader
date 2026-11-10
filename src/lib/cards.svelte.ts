// Which row is open as a card. One at a time; changing page closes it.
let open = $state<string | null>(null);

export const cards = {
  isOpen: (key: string) => open === key,
  toggle(key: string): void {
    open = open === key ? null : key;
  },
  close(): void {
    open = null;
  },
};
