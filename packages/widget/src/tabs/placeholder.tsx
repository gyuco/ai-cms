/** Shown by tabs whose content is not available yet. */
export function Placeholder({ description }: { description: string }) {
  return (
    <div class="placeholder">
      <p class="placeholder-title">Disponibile a breve</p>
      <p class="placeholder-text">{description}</p>
    </div>
  );
}
