const SLOTS = 8;

export function ItemsPanel() {
  return (
    <section className="panel">
      <h2 className="panel-title">ITEMS</h2>
      <div className="inventory-grid">
        {Array.from({ length: SLOTS }, (_, index) => (
          <div key={index} className="inventory-slot" />
        ))}
      </div>
      <div className="inventory-space" />
    </section>
  );
}
