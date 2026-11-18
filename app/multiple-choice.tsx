"use client";

export function MultipleChoice({ label, options, optionLabels, caseSensitive = false, value, onChange, disabled = false, required = false, autoFocus = false, invalid, describedBy }: {
  label: string; options: readonly string[]; optionLabels?:Record<string,string>; caseSensitive?:boolean; value: unknown; onChange: (value: string[]) => void;
  disabled?: boolean; required?: boolean; autoFocus?: boolean; invalid?: boolean; describedBy?: string;
}) {
  const key = (value: unknown) => caseSensitive ? String(value) : String(value).toLowerCase();
  const selected = new Set(Array.isArray(value) ? value.map(key) : []);
  return <fieldset className="multiple-choice" disabled={disabled} aria-invalid={invalid} aria-describedby={describedBy}>
    <legend>{label}{required ? " *" : ""}</legend>
    <div className="multiple-choice-options">
      {options.map((option, i) => <label key={option}>
        <input type="checkbox" checked={selected.has(key(option))} autoFocus={autoFocus && i === 0}
          required={required && selected.size === 0 && i === 0}
          onChange={e => { const next = new Set(selected); e.target.checked ? next.add(key(option)) : next.delete(key(option)); onChange(options.filter(o => next.has(key(o)))); }} />
        <span>{optionLabels?.[option] || option}</span>
      </label>)}
    </div>
    <div className="multiple-choice-footer"><small>{selected.size ? `${selected.size} selected` : "No selections"}</small>
      <button type="button" className="text-button" disabled={disabled || !selected.size} onClick={() => onChange([])}>Clear selections</button>
    </div>
  </fieldset>;
}
