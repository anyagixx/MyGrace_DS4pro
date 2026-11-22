// START_MODULE_CONTRACT
//   PURPOSE: Maintain a shopping cart with validated quantities and exact totals.
//   SCOPE: createCart(), addItem(), subtotalCents(), renderSubtotal(); throws CartError on invalid input.
//   DEPENDS: M-CATALOG, M-MONEY
//   LINKS: docs/modules/M-CART.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   createCart    — empty cart
//   addItem       — validate quantity/stock and store an item
//   subtotalCents — exact integer-cent total
//   renderSubtotal — formatted total string
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.0.0 — initial implementation; composes catalog + money modules
// END_CHANGE_SUMMARY

import { findProduct, type Catalog } from "../catalog/index";
import { formatAmount } from "../money/index";

export interface CartItem {
  productId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Cart {
  items: CartItem[];
}

export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartError";
  }
}

export function createCart(): Cart {
  return { items: [] };
}

// START_CONTRACT: addItem
//   PURPOSE: Add a product to the cart after validating quantity and stock.
//   INPUTS: cart, catalog, productId, quantity
//   OUTPUTS: the same cart (mutated for convenience)
//   ERRORS: CartError for invalid quantity/stock; CatalogError for unknown products
// END_CONTRACT: addItem
export function addItem(cart: Cart, catalog: Catalog, productId: string, quantity: number): Cart {
  // START_BLOCK_VALIDATE_QUANTITY
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new CartError(`quantity must be a positive integer, got ${quantity}`);
  }
  // END_BLOCK_VALIDATE_QUANTITY

  // START_BLOCK_RESOLVE_AND_STORE
  const product = findProduct(catalog, productId);
  if (quantity > product.stock) throw new CartError(`not enough stock for ${productId}`);
  const existing = cart.items.find((item) => item.productId === productId);
  if (existing !== undefined) existing.quantity += quantity;
  else cart.items.push({ productId, quantity, unitPriceCents: product.priceCents });
  return cart;
  // END_BLOCK_RESOLVE_AND_STORE
}

export function subtotalCents(cart: Cart): number {
  return cart.items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0);
}

export function renderSubtotal(cart: Cart): string {
  return formatAmount(subtotalCents(cart));
}
