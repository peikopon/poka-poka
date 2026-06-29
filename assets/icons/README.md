# Poker Icon Set

Modern, bright SVG icon pack for the poker app, with fruit-hat human player avatars.

## Files

- `poker-icons.svg` contains every icon as a `<symbol>`.
- `manifest.json` lists symbol ids by product area.
- `palette.css` exposes the shared color palette as CSS variables.

## Use

```html
<svg width="32" height="32" aria-hidden="true">
  <use href="/assets/icons/poker-icons.svg#poker-chip"></use>
</svg>
```

For accessible icon-only buttons, keep the SVG hidden and put the label on the button:

```html
<button aria-label="Raise">
  <svg width="24" height="24" aria-hidden="true">
    <use href="/assets/icons/poker-icons.svg#action-raise-bet"></use>
  </svg>
</button>
```

## Included Icons

Tier 1:

- Card suits: `suit-spade`, `suit-heart`, `suit-diamond`, `suit-club`
- Player avatars: `avatar-01` through `avatar-09`
- Actions: `action-fold`, `action-check`, `action-call`, `action-raise-bet`, `action-all-in`
- Currency: `poker-chip`, legacy aliases `chip-small`, `chip-medium`, `chip-large`, plus denomination chips `chip-1`, `chip-5`, `chip-10`, `chip-25`, `chip-50`, `chip-100`, `chip-500`
- Brand: `app-logo-mark`

Tier 2 and polish:

- Cards: `card-blank`, `card-back`, `hole-cards`, `deck`, `shuffle`
- Positions: `dealer-button`, `blind-small`, `blind-big`
- Economy: `pot-chips`, `chip-stack`, `wallet`, `buy-in`, `cash-out`
- Social: `chat-bubble`, `emoji-reaction`, `invite-friend`, `profile-user`, `leaderboard`, `hand-history`
- Navigation & UI: `settings`, `home`, `search`, `notification-bell`, `info`, `close`, `menu`, `back-arrow`
- Lobby: `host-crown`, `dealer-button`, `copy-code`, `start-game`, `kick-player`, `ready-status`, `waiting-status`
- Feedback: `timer-turn-clock`, `winner-trophy`, `connection`, `sound-on`, `sound-off`

The suits (`suit-spade`, `suit-heart`, `suit-diamond`, `suit-club`) now use soft gradient fills with a unified outline and a light highlight so they sit consistently next to the chips and avatars.
