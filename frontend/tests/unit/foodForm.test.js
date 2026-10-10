import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyFoodForm,
  formatAddOns,
  foodToForm,
  formToPayload,
  parseAddOns,
  parseList,
} from "../../src/lib/foodForm.js";

const valid = () => ({ ...emptyFoodForm(), name: "Paneer Tikka", price: "180" });

test("parseList trims, drops blanks and removes case-insensitive duplicates", () => {
  assert.deepEqual(parseList(" milk, Gluten ,, milk , GLUTEN, nuts "), ["milk", "Gluten", "nuts"]);
  assert.deepEqual(parseList(""), []);
  assert.deepEqual(parseList(undefined), []);
});

test("parseAddOns reads label:price pairs separated by semicolons or new lines", () => {
  assert.deepEqual(parseAddOns("Extra cheese:20; Less spicy:0\nNo onion"), [
    { label: "Extra cheese", price: 20 },
    { label: "Less spicy", price: 0 },
    { label: "No onion", price: 0 },
  ]);
});

test("parseAddOns rejects bad prices, blank names and duplicates with a readable message", () => {
  assert.throws(() => parseAddOns("Cheese:-5"), /between 0 and 1000/);
  assert.throws(() => parseAddOns("Cheese:abc"), /between 0 and 1000/);
  assert.throws(() => parseAddOns(":20"), /needs a name/);
  assert.throws(() => parseAddOns("Cheese:5; cheese:9"), /Duplicate add-on/);
});

test("parseAddOns caps the number of add-ons", () => {
  const eleven = Array.from({ length: 11 }, (_, i) => `Item${i}:1`).join(";");
  assert.throws(() => parseAddOns(eleven), /At most 10/);
});

test("formatAddOns is the inverse of parseAddOns for the edit form", () => {
  const addOns = [
    { label: "Extra cheese", price: 20 },
    { label: "Less spicy", price: 0 },
  ];
  assert.deepEqual(parseAddOns(formatAddOns(addOns)), addOns);
  assert.equal(formatAddOns(undefined), "");
});

test("formToPayload builds the API body with typed values", () => {
  const payload = formToPayload({
    ...valid(),
    description: "  Smoky  ",
    category: "Starters",
    dietary: "veg",
    prepTimeMinutes: "12",
    featured: true,
    ingredients: "paneer, yoghurt",
    allergens: "milk",
    addOns: "Extra mint chutney:10",
  });
  assert.deepEqual(payload, {
    name: "Paneer Tikka",
    description: "Smoky",
    price: 180,
    image: null,
    category: "Starters",
    dietary: "veg",
    prepTimeMinutes: 12,
    featured: true,
    ingredients: ["paneer", "yoghurt"],
    allergens: ["milk"],
    addOns: [{ label: "Extra mint chutney", price: 10 }],
  });
});

test("formToPayload omits a blank prep time (so an edit keeps the old value) and sends null diet", () => {
  const payload = formToPayload(valid());
  assert.equal("prepTimeMinutes" in payload, false);
  assert.equal(payload.dietary, null);
  assert.equal(payload.category, "General");
});

test("formToPayload rejects invalid input before any request is sent", () => {
  assert.throws(() => formToPayload({ ...valid(), name: "  " }), /Name is required/);
  assert.throws(() => formToPayload({ ...valid(), price: "" }), /greater than zero/);
  assert.throws(() => formToPayload({ ...valid(), price: "0" }), /greater than zero/);
  assert.throws(() => formToPayload({ ...valid(), prepTimeMinutes: "10.5" }), /whole number/);
  assert.throws(() => formToPayload({ ...valid(), prepTimeMinutes: "300" }), /0 to 240/);
});

test("foodToForm pre-fills the editor from a stored menu item and round-trips", () => {
  const food = {
    name: "Chai",
    description: "Ginger",
    price: 15,
    image: "https://example.com/chai.jpg",
    category: "General",
    dietary: "veg",
    prepTimeMinutes: 5,
    featured: true,
    ingredients: ["tea", "ginger"],
    allergens: ["milk"],
    addOns: [{ label: "Extra sugar", price: 0 }],
  };
  const form = foodToForm(food);
  assert.equal(form.category, "", "the default category is shown as blank");
  assert.equal(form.price, "15");
  assert.equal(form.ingredients, "tea, ginger");
  const payload = formToPayload(form);
  assert.equal(payload.name, "Chai");
  assert.equal(payload.prepTimeMinutes, 5);
  assert.deepEqual(payload.allergens, ["milk"]);
  assert.deepEqual(payload.addOns, [{ label: "Extra sugar", price: 0 }]);
});
