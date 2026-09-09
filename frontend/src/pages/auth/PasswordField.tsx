import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import clsx from "clsx";

export function strengthOf(password: string) {
  const checks = [
    password.length >= 8,
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  const score = checks.filter(Boolean).length;
  const missing: string[] = [];
  if (!checks[0]) missing.push("8 characters");
  if (!checks[1] || !checks[2]) missing.push("upper and lower case");
  if (!checks[3]) missing.push("a number");
  if (!checks[4]) missing.push("a symbol");
  return { score, missing };
}

const BANDS = [
  { label: "Too short", className: "bg-critical" },
  { label: "Weak", className: "bg-critical" },
  { label: "Fair", className: "bg-low" },
  { label: "Good", className: "bg-low" },
  { label: "Strong", className: "bg-healthy" },
  { label: "Strong", className: "bg-healthy" },
];

export function PasswordField({
  value, onChange, label, showMeter = false, autoComplete = "new-password",
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  showMeter?: boolean;
  autoComplete?: string;
}) {
  const [reveal, setReveal] = useState(false);
  const { score, missing } = strengthOf(value);
  const band = BANDS[score];

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <div className="relative">
        <input
          type={reveal ? "text" : "password"}
          className="field pr-11"
          value={value}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          required
        />
        <button type="button" onClick={() => setReveal((v) => !v)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-2 text-ink-muted hover:text-ink"
          aria-label={reveal ? "Hide password" : "Show password"}>
          {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>

      {showMeter && value && (
        <div className="space-y-1.5 pt-0.5">
          <div className="flex gap-1" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={clsx("h-1 flex-1 rounded-full transition-colors",
                i < Math.max(score - 1, 0) ? band.className : "bg-line")} />
            ))}
          </div>
          <p className="text-micro text-ink-muted">
            <span className="font-medium text-ink">{band.label}</span>
            {missing.length > 0 && <> — add {missing.join(", ")}.</>}
          </p>
        </div>
      )}
    </div>
  );
}
