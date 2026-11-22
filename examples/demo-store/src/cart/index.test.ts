import { describe, expect, test } from "bun:test";
import { CatalogError, createCatalog } from "../catalog/index";
import { CartError, addItem, createCart, renderSubtotal, subtotalCents } from "./index";

const catalog = createCatalog([
  { id: "sku-1", name: "Keyboard", priceCents: 4900, stock: 3 },
  { id: "sku-2", name: "Mouse", priceCents: 1900, stock: 1 },
]);

describe("M-CART addItem", () => {
  test("stores items and accumulates quantity", () => {
    const cart = createCart();
    addItem(cart, catalog, "sku-1", 1);
    addItem(cart, catalog, "sku-1", 2);
    expect(cart.items).toEqual([{ productId: "sku-1", quantity: 3, unitPriceCents: 4900 }]);
  });

  test("rejects non-positive and fractional quantities", () => {
    const cart = createCart();
    expect(() => addItem(cart, catalog, "sku-1", 0)).toThrow(CartError);
    expect(() => addItem(cart, catalog, "sku-1", 1.5)).toThrow("quantity must be a positive integer");
  });

  test("rejects unknown products and insufficient stock", () => {
    const cart = createCart();
    expect(() => addItem(cart, catalog, "missing", 1)).toThrow(CatalogError);
    expect(() => addItem(cart, catalog, "sku-2", 2)).toThrow("not enough stock for sku-2");
  });
});

describe("M-CART totals", () => {
  test("computes exact integer-cent subtotals through the money module", () => {
    const cart = createCart();
    addItem(cart, catalog, "sku-1", 2);
    addItem(cart, catalog, "sku-2", 1);
    expect(subtotalCents(cart)).toBe(11700);
    expect(renderSubtotal(cart)).toBe("117.00");
  });

  test("an empty cart is exactly zero", () => {
    expect(subtotalCents(createCart())).toBe(0);
    expect(renderSubtotal(createCart())).toBe("0.00");
  });
});
