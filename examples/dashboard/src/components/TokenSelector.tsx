import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import styles from "./TokenSelector.module.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Token {
  /** Unique identifier, e.g. contract address or symbol. */
  id: string;
  /** Ticker symbol shown in the trigger button, e.g. "XLM". */
  symbol: string;
  /** Human-readable name shown in the dropdown, e.g. "Stellar Lumens". */
  name: string;
  /** Optional URL for the token logo image. */
  logoUrl?: string;
}

export interface TokenSelectorProps {
  /** Full list of tokens to display in the dropdown. */
  tokens?: Token[] | null;
  /** Currently selected token. Pass `null` for no selection. */
  value: Token | null;
  /** Called when the user picks a token. */
  onChange: (token: Token) => void;
  /** Placeholder text shown in the trigger when no token is selected. */
  placeholder?: string;
  /** Disables the selector entirely. */
  disabled?: boolean;
  /** Additional class applied to the outermost wrapper. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TokenSelector: React.FC<TokenSelectorProps> = ({
  tokens = [],
  value,
  onChange,
  placeholder = "Select token",
  disabled = false,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const safeTokens = Array.isArray(tokens) ? tokens : [];

  // -------------------------------------------------------------------------
  // Filtered list
  // -------------------------------------------------------------------------

  const filtered = query.trim()
    ? safeTokens.filter((t) => {
        const symbol = typeof t?.symbol === "string" ? t.symbol : "";
        const name = typeof t?.name === "string" ? t.name : "";
        return (
          symbol.toLowerCase().includes(query.toLowerCase()) ||
          name.toLowerCase().includes(query.toLowerCase())
        );
      })
    : safeTokens;

  // -------------------------------------------------------------------------
  // Open / close helpers
  // -------------------------------------------------------------------------

  const openDropdown = () => {
    if (disabled) return;
    setOpen(true);
    // Focus the search input on the next paint so the dropdown is visible.
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const handleSelect = (token: Token) => {
    onChange(token);
    closeDropdown();
  };

  // -------------------------------------------------------------------------
  // Keyboard navigation
  // -------------------------------------------------------------------------

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      openDropdown();
    }
    if (e.key === "Escape") closeDropdown();
  };

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      closeDropdown();
      wrapperRef.current?.querySelector("button")?.focus();
    }
  };

  // -------------------------------------------------------------------------
  // Close on outside click
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        closeDropdown();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open, closeDropdown]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div ref={wrapperRef} className={`${styles.wrapper} ${className ?? ""}`}>
      {/* Trigger */}
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={value ? `Selected token: ${value.symbol}` : placeholder}
        disabled={disabled}
        className={[
          styles.trigger,
          open ? styles.triggerOpen : "",
          disabled ? styles.triggerDisabled : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => (open ? closeDropdown() : openDropdown())}
        onKeyDown={handleTriggerKeyDown}
      >
        {value ? (
          value.logoUrl ? (
            <img
              src={value.logoUrl}
              alt={`${value.symbol} logo`}
              className={styles.tokenLogo}
            />
          ) : (
            <span className={styles.tokenLogoPlaceholder} aria-hidden="true" />
          )
        ) : null}

        <span>{value ? value.symbol : placeholder}</span>

        {/* Chevron SVG — inline so it is never an extra network request */}
        <svg
          className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className={styles.dropdown} onKeyDown={handleListKeyDown}>
          {/* Search */}
          <div className={styles.searchRow}>
            <svg
              className={styles.searchIcon}
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M12.9 14.32a8 8 0 111.414-1.414l4.387 4.387a1 1 0 01-1.414 1.414l-4.387-4.387zM8 14A6 6 0 108 2a6 6 0 000 12z"
                clipRule="evenodd"
              />
            </svg>
            <input
              ref={searchRef}
              type="text"
              role="searchbox"
              aria-label="Search tokens"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={styles.searchInput}
            />
          </div>

          {/* Token list */}
          <div
            id={listboxId}
            role="listbox"
            aria-label="Tokens"
            className={styles.list}
          >
            {filtered.length === 0 ? (
              <div className={styles.empty}>No tokens found</div>
            ) : (
              filtered.map((token) => {
                const isSelected = value?.id === token.id;
                return (
                  <button
                    key={token.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={[
                      styles.option,
                      isSelected ? styles.optionSelected : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => handleSelect(token)}
                  >
                    {token.logoUrl ? (
                      <img
                        src={token.logoUrl}
                        alt={`${token.symbol} logo`}
                        className={styles.tokenLogo}
                      />
                    ) : (
                      <span
                        className={styles.tokenLogoPlaceholder}
                        aria-hidden="true"
                      />
                    )}

                    <span className={styles.tokenInfo}>
                      <span className={styles.tokenSymbol}>{token.symbol}</span>
                      <span className={styles.tokenName}>{token.name}</span>
                    </span>

                    {isSelected && (
                      <svg
                        className={styles.checkmark}
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
