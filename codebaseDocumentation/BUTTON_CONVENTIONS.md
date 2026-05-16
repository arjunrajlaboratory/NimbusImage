# Button Conventions

How `<v-btn>` (Vuetify 4) should be styled across NimbusImage.

## Why this exists

A 2026 audit of 300 button instances found:

- **70%** of buttons omitted `variant`, falling back to Vuetify's implicit `elevated` default.
- **70%** omitted `size`, falling back to the default (larger) size.
- Literal colors (`red`, `green`, `orange`, `grey`) were used alongside semantic tokens (`error`, `success`, `warning`, `secondary`) for the same intents.
- No agreed convention for "primary CTA" vs "secondary" vs "destructive" — every author picked props ad hoc.

These conventions standardize button roles so the visual hierarchy on every page reads the same way.

## The five button roles

### 1. Primary

The single main action of a view, dialog, or section — the thing the user is most likely to want.

```vue
<v-btn variant="flat" color="primary" size="small" @click="save">
  Save
</v-btn>
```

For positive/affirmative CTAs (View, Go, Start), use `color="success"`:

```vue
<v-btn variant="flat" color="success" size="small" @click="goToView">
  <v-icon start>mdi-eye</v-icon>
  View
</v-btn>
```

**Rule of thumb:** at most one primary button per surface.

### 2. Secondary

Supporting actions next to a primary action, or independent actions that aren't the main CTA.

```vue
<v-btn variant="outlined" color="primary" size="small" @click="share">
  <v-icon start>mdi-share-variant</v-icon>
  Share
</v-btn>
```

### 3. Tertiary / text

Low-emphasis actions: Cancel buttons, inline actions, link-like buttons.

```vue
<v-btn variant="text" size="small" @click="cancel">Cancel</v-btn>
```

### 4. Destructive

Irreversible or risky actions: delete, remove, revoke.

**Confirmed** (the irreversible button inside a confirmation dialog, or in a primary-action slot):

```vue
<v-btn variant="flat" color="error" size="small" @click="confirmDelete">
  Delete
</v-btn>
```

**Inline trigger** (the button the user clicks to open the confirm dialog or initiate a soft removal):

```vue
<v-btn variant="text" color="error" size="small" @click="askDelete">
  <v-icon start>mdi-delete</v-icon>
  Remove
</v-btn>
```

### 5. Icon-only

Toolbar icons and row actions where the icon is self-explanatory.

```vue
<v-btn variant="text" icon size="small" @click="edit">
  <v-icon>mdi-pencil</v-icon>
</v-btn>
```

Wrap any icon-only button whose meaning isn't 100% obvious in a tooltip:

```vue
<v-tooltip text="Edit annotation">
  <template #activator="{ props }">
    <v-btn v-bind="props" variant="text" icon size="small" @click="edit">
      <v-icon>mdi-pencil</v-icon>
    </v-btn>
  </template>
</v-tooltip>
```

## Sizing

| Size | When |
|---|---|
| `size="small"` | **Default for almost everything.** Toolbar buttons, dialog actions, list actions, secondary CTAs. |
| `size="default"` | Reserved for true page-level hero CTAs. Use sparingly. |
| `size="x-small"` | Tight inline contexts (dense tables, chip-like buttons). |

`size` should never be omitted — Vuetify's implicit default is too large for our density.

## Color tokens — semantic, not literal

| Don't | Do | Why |
|---|---|---|
| `color="red"` | `color="error"` | Theme-aware: respects dark/light, matches other error UI. |
| `color="green"` | `color="success"` | Same. |
| `color="orange"` | `color="warning"` | Same. |
| `color="grey"` / `color="white"` | omit, or `color="secondary"` | Theme-aware. |

Literal CSS color names (`red`, `green`, `orange`) don't shift with the theme — semantic tokens (`error`, `success`, `warning`) do, and they match the rest of the design system.

## Dialog action bars

Always `[text Cancel] [flat/outlined Confirm]`. Never two filled buttons.

```vue
<v-card-actions class="button-bar">
  <v-btn variant="text" size="small" @click="close">Cancel</v-btn>
  <v-btn variant="flat" color="primary" size="small" @click="save">Save</v-btn>
</v-card-actions>
```

For destructive confirm dialogs:

```vue
<v-card-actions class="button-bar">
  <v-btn variant="text" size="small" @click="close">Cancel</v-btn>
  <v-btn variant="flat" color="error" size="small" @click="confirmDelete">
    Remove
  </v-btn>
</v-card-actions>
```

## Toolbar buttons

When buttons sit in a `v-toolbar` with a mix of secondary actions and a primary CTA:

```vue
<v-toolbar>
  <v-toolbar-title>Dataset</v-toolbar-title>
  <v-spacer />
  <v-btn variant="outlined" color="primary" size="small">Share</v-btn>
  <v-btn variant="outlined" color="primary" size="small">Copy link</v-btn>
  <v-btn variant="flat" color="success" size="small">
    <v-icon start>mdi-eye</v-icon>
    View
  </v-btn>
</v-toolbar>
```

All buttons at the same size so heights match; secondary actions outlined; the single primary CTA filled.

## `:to` vs `@click`

A `v-btn` with `:to` renders as an `<a>`; one with `@click` renders as a `<button>`. They look identical *if* both inherit the page font — `src/style.scss` ensures form elements inherit `font-family`. If you ever see size/font drift between two visually-identical buttons in the same row, check that they're both `<a>` or both `<button>`, or that the font-inherit rule still exists.

For groups of buttons that should look identical (e.g. three secondary buttons stacked in a card), prefer using the same action type for all of them — either all `:to`-based or all `@click`-based with `router.push` — so they render with the same tag.

## Always-required props

- **`size`** — never omit. Default to `small`.
- **`variant`** — never omit. Vuetify's implicit `elevated` default looks generic and doesn't fit the Linear-inspired theme.

## Quick reference

```vue
<!-- Primary CTA -->
<v-btn variant="flat" color="primary" size="small">Save</v-btn>

<!-- Primary positive CTA -->
<v-btn variant="flat" color="success" size="small">View</v-btn>

<!-- Secondary -->
<v-btn variant="outlined" color="primary" size="small">Share</v-btn>

<!-- Tertiary -->
<v-btn variant="text" size="small">Cancel</v-btn>

<!-- Destructive (confirmed) -->
<v-btn variant="flat" color="error" size="small">Delete</v-btn>

<!-- Destructive (inline) -->
<v-btn variant="text" color="error" size="small">Remove</v-btn>

<!-- Icon-only -->
<v-btn variant="text" icon size="small">
  <v-icon>mdi-pencil</v-icon>
</v-btn>
```

## Migrating existing buttons

When you touch a file with old-style buttons, normalize them as part of the change:

1. Add `variant=` if it's missing (decide which role applies).
2. Add `size="small"` if it's missing.
3. Replace literal colors (`red`/`green`/`orange`) with semantic tokens.
4. If multiple buttons in the same row use different heights/styles for the same role, unify them.

Don't open a separate refactor PR for the whole codebase — let the conventions propagate naturally as files get touched. The initial sweep (commit `button-consistency`) handled the high-traffic cases.
