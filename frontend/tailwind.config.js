/** RetailMind AI — luxury retail intelligence.
 *
 *  Palette: peach, deep red, white, per the brief.
 *
 *  One conflict had to be resolved. Deep red is the brand colour, but red is
 *  also the natural signal for "critical stock". If both are the same red, the
 *  interface loses its most important distinction. So the brand owns the deep
 *  wine end of the range (#5A1420 / #7A1F2B) for chrome and emphasis, while
 *  status colours sit in a muted, earthy register that reads as information
 *  rather than decoration — critical takes the brighter rose (#A63A45) so it
 *  separates cleanly from brand surfaces.
 */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Surfaces — predominantly white and warm ivory
        canvas:  { DEFAULT: "#FCFAF8", tint: "#F5F0EC", deep: "#EFE7E1" },
        surface: { DEFAULT: "#FFFFFF", raised: "#FBF7F4", hover: "#F5EFEA" },

        // Brand — peach through deep wine
        peach:   { light: "#FCE6DC", soft: "#F8C7B5", DEFAULT: "#F3A58B" },
        wine:    { DEFAULT: "#7A1F2B", deep: "#5A1420", rose: "#A63A45" },

        ink:     { DEFAULT: "#1C1717", muted: "#6F6663", faint: "#9A908C" },
        line:    { DEFAULT: "rgba(122,31,43,0.10)", strong: "rgba(122,31,43,0.20)" },

        // Status — muted and earthy, deliberately not neon
        healthy:   { DEFAULT: "#2E6B4F", soft: "#E8F1EC" },
        low:       { DEFAULT: "#B8792C", soft: "#FBF0DF" },
        critical:  { DEFAULT: "#A63A45", soft: "#FBE9EA" },
        overstock: { DEFAULT: "#4A5578", soft: "#ECEEF5" },
      },
      fontFamily: {
        // Fraunces carries the luxury-retail register; Inter keeps dense data legible.
        display: ["Fraunces", "Georgia", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      fontSize: {
        micro: ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.005em" }],
      },
      borderRadius: { xl: "1rem", "2xl": "1.375rem", "3xl": "1.75rem" },
      boxShadow: {
        // Warm-tinted rather than grey — grey shadows on ivory look dirty.
        card: "0 1px 2px rgba(90,20,32,.04), 0 8px 24px -16px rgba(90,20,32,.14)",
        lift: "0 2px 6px rgba(90,20,32,.06), 0 24px 48px -24px rgba(90,20,32,.22)",
        glass: "0 8px 40px -12px rgba(90,20,32,.20), inset 0 1px 0 rgba(255,255,255,.7)",
      },
      backdropBlur: { luxe: "22px" },
      keyframes: {
        "fade-rise": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "sheen": {
          "0%": { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(220%)" },
        },
      },
      animation: {
        "fade-rise": "fade-rise .5s cubic-bezier(.22,.8,.3,1) both",
        sheen: "sheen 1.5s cubic-bezier(.4,0,.2,1) infinite",
      },
    },
  },
  plugins: [],
};
