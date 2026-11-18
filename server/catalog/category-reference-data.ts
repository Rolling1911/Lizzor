export interface CanonicalCategoryReference {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  canonicalKey: string;
  active: boolean;
  sortOrder: number;
}

// Stable reference identities audited from the canonical development taxonomy.
export const canonicalCategoryReferences: readonly CanonicalCategoryReference[] = [
  {
    "id": "2d8b0780-b8cc-4ad8-b1f8-5ac28a65e373",
    "parentId": null,
    "name": "Women",
    "slug": "women",
    "canonicalKey": "women",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "2a885c30-0ee1-4c0d-bccd-bced4dced7b5",
    "parentId": "2d8b0780-b8cc-4ad8-b1f8-5ac28a65e373",
    "name": "Clothing",
    "slug": "women-clothing",
    "canonicalKey": "women.clothing",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "304ff0bb-48c4-400d-9b6f-2666298437c0",
    "parentId": "2d8b0780-b8cc-4ad8-b1f8-5ac28a65e373",
    "name": "Shoes",
    "slug": "women-shoes",
    "canonicalKey": "women.shoes",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "7805505a-7b4b-4b29-b178-c262f42ee8c3",
    "parentId": "2d8b0780-b8cc-4ad8-b1f8-5ac28a65e373",
    "name": "Bags",
    "slug": "women-bags",
    "canonicalKey": "women.bags",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "df015c50-ed00-4c99-b3bb-f37fcf7c082a",
    "parentId": "2d8b0780-b8cc-4ad8-b1f8-5ac28a65e373",
    "name": "Jewellery & Accessories",
    "slug": "women-jewellery-accessories",
    "canonicalKey": "women.jewellery-accessories",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "2bdcbddc-4262-497b-963f-515ea23cf82e",
    "parentId": "2d8b0780-b8cc-4ad8-b1f8-5ac28a65e373",
    "name": "Activewear",
    "slug": "women-activewear",
    "canonicalKey": "women.activewear",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "81fb124a-87e2-49f8-bb17-42bb48d32e7a",
    "parentId": null,
    "name": "Men",
    "slug": "men",
    "canonicalKey": "men",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "2c91e707-78d7-4393-974a-84da37295476",
    "parentId": "81fb124a-87e2-49f8-bb17-42bb48d32e7a",
    "name": "Clothing",
    "slug": "men-clothing",
    "canonicalKey": "men.clothing",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "ec69e9f7-a0f4-4d57-a2a3-10893a7764e0",
    "parentId": "81fb124a-87e2-49f8-bb17-42bb48d32e7a",
    "name": "Shoes",
    "slug": "men-shoes",
    "canonicalKey": "men.shoes",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "2bb0f325-2779-4425-a677-1b034bd1c527",
    "parentId": "81fb124a-87e2-49f8-bb17-42bb48d32e7a",
    "name": "Bags & Accessories",
    "slug": "men-bags-accessories",
    "canonicalKey": "men.bags-accessories",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "ce931a4f-9b8c-4368-86a2-fef2fbd2ba2f",
    "parentId": "81fb124a-87e2-49f8-bb17-42bb48d32e7a",
    "name": "Activewear",
    "slug": "men-activewear",
    "canonicalKey": "men.activewear",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "3fea9407-e8e5-4af1-bb4c-fc8cd07e877a",
    "parentId": null,
    "name": "Kids & Baby",
    "slug": "kids-baby",
    "canonicalKey": "kids-baby",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "6d09d302-5c20-4ab2-b1e7-90e4e543c879",
    "parentId": "3fea9407-e8e5-4af1-bb4c-fc8cd07e877a",
    "name": "Girls",
    "slug": "kids-baby-girls",
    "canonicalKey": "kids-baby.girls",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "1b7e871d-1fb3-4838-817f-94fd60b0c919",
    "parentId": "3fea9407-e8e5-4af1-bb4c-fc8cd07e877a",
    "name": "Boys",
    "slug": "kids-baby-boys",
    "canonicalKey": "kids-baby.boys",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "c612b48b-50d4-493f-9a3d-441c5f892436",
    "parentId": "3fea9407-e8e5-4af1-bb4c-fc8cd07e877a",
    "name": "Baby Clothing",
    "slug": "kids-baby-clothing",
    "canonicalKey": "kids-baby.baby-clothing",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "5b4d9942-362b-4538-b28f-45b590750272",
    "parentId": "3fea9407-e8e5-4af1-bb4c-fc8cd07e877a",
    "name": "Baby Essentials",
    "slug": "kids-baby-essentials",
    "canonicalKey": "kids-baby.baby-essentials",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "ee8d180b-dd2e-451b-9129-7f19663a256d",
    "parentId": "3fea9407-e8e5-4af1-bb4c-fc8cd07e877a",
    "name": "Maternity",
    "slug": "kids-baby-maternity",
    "canonicalKey": "kids-baby.maternity",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "b2e3df42-d570-4603-be35-93d827ec7c6a",
    "parentId": null,
    "name": "Home & Kitchen",
    "slug": "home-kitchen",
    "canonicalKey": "home-kitchen",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "4244bda6-eaee-4978-a8f0-053648efd6dd",
    "parentId": "b2e3df42-d570-4603-be35-93d827ec7c6a",
    "name": "Kitchen & Dining",
    "slug": "home-kitchen-kitchen-dining",
    "canonicalKey": "home-kitchen.kitchen-dining",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "38578b0e-e857-4a70-92fd-4c144de1d564",
    "parentId": "b2e3df42-d570-4603-be35-93d827ec7c6a",
    "name": "Storage & Organization",
    "slug": "home-kitchen-storage-organization",
    "canonicalKey": "home-kitchen.storage-organization",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "700f15e7-2c23-4aca-8650-998189c6f63e",
    "parentId": "b2e3df42-d570-4603-be35-93d827ec7c6a",
    "name": "Home Décor",
    "slug": "home-kitchen-home-decor",
    "canonicalKey": "home-kitchen.home-d-cor",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "987fa88b-ed85-4766-a027-e2fc2de77cf9",
    "parentId": "b2e3df42-d570-4603-be35-93d827ec7c6a",
    "name": "Bedding & Textiles",
    "slug": "home-kitchen-bedding-textiles",
    "canonicalKey": "home-kitchen.bedding-textiles",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "a7f4f03d-8494-4879-bc9a-81070f964c4a",
    "parentId": "b2e3df42-d570-4603-be35-93d827ec7c6a",
    "name": "Cleaning",
    "slug": "home-kitchen-cleaning",
    "canonicalKey": "home-kitchen.cleaning",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "49f8589c-8bb3-443b-a8c2-1b352133b0bb",
    "parentId": "b2e3df42-d570-4603-be35-93d827ec7c6a",
    "name": "Bathroom",
    "slug": "home-kitchen-bathroom",
    "canonicalKey": "home-kitchen.bathroom",
    "active": true,
    "sortOrder": 6
  },
  {
    "id": "8d492e48-4ee3-48dc-933e-700c8aebb046",
    "parentId": "b2e3df42-d570-4603-be35-93d827ec7c6a",
    "name": "Lighting",
    "slug": "home-kitchen-lighting",
    "canonicalKey": "home-kitchen.lighting",
    "active": true,
    "sortOrder": 7
  },
  {
    "id": "89b60395-164e-4aad-82ec-44e7d567cbb5",
    "parentId": "b2e3df42-d570-4603-be35-93d827ec7c6a",
    "name": "Garden & Outdoor",
    "slug": "home-kitchen-garden-outdoor",
    "canonicalKey": "home-kitchen.garden-outdoor",
    "active": true,
    "sortOrder": 8
  },
  {
    "id": "258f1c86-9e9d-4b71-ac75-e551c231ced6",
    "parentId": "b2e3df42-d570-4603-be35-93d827ec7c6a",
    "name": "Furniture",
    "slug": "home-kitchen-furniture",
    "canonicalKey": "home-kitchen.furniture",
    "active": true,
    "sortOrder": 9
  },
  {
    "id": "5ff935ad-beaf-477e-8d5c-0688123ac756",
    "parentId": null,
    "name": "Electronics",
    "slug": "electronics",
    "canonicalKey": "electronics",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "77eb301c-065e-46ef-be35-4d1e5646e107",
    "parentId": "5ff935ad-beaf-477e-8d5c-0688123ac756",
    "name": "Phone Accessories",
    "slug": "electronics-phone-accessories",
    "canonicalKey": "electronics.phone-accessories",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "85dd0c95-9713-4a0c-87cd-d4ef0e4c3961",
    "parentId": "5ff935ad-beaf-477e-8d5c-0688123ac756",
    "name": "Cables & Chargers",
    "slug": "electronics-cables-chargers",
    "canonicalKey": "electronics.cables-chargers",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "f644b951-58f5-4362-b661-409f81639af2",
    "parentId": "5ff935ad-beaf-477e-8d5c-0688123ac756",
    "name": "Audio & Earbuds",
    "slug": "electronics-audio-earbuds",
    "canonicalKey": "electronics.audio-earbuds",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "55b8003a-6414-4c5a-8e4b-b18052ca0eec",
    "parentId": "5ff935ad-beaf-477e-8d5c-0688123ac756",
    "name": "Smartwatches & Wearables",
    "slug": "electronics-smartwatches-wearables",
    "canonicalKey": "electronics.smartwatches-wearables",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "d72ba6b7-d44f-4b71-b4dc-98c31db484a3",
    "parentId": "5ff935ad-beaf-477e-8d5c-0688123ac756",
    "name": "Power Banks",
    "slug": "electronics-power-banks",
    "canonicalKey": "electronics.power-banks",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "b19369c8-b8bd-47fd-bd3d-328708721f11",
    "parentId": "5ff935ad-beaf-477e-8d5c-0688123ac756",
    "name": "Computer Accessories",
    "slug": "electronics-computer-accessories",
    "canonicalKey": "electronics.computer-accessories",
    "active": true,
    "sortOrder": 6
  },
  {
    "id": "3b9cddea-7b1b-42c9-99cc-587c4778ff1d",
    "parentId": "5ff935ad-beaf-477e-8d5c-0688123ac756",
    "name": "Smart Home",
    "slug": "electronics-smart-home",
    "canonicalKey": "electronics.smart-home",
    "active": true,
    "sortOrder": 7
  },
  {
    "id": "47866b1d-1f56-4ca2-b7b8-8cb129f4e194",
    "parentId": "5ff935ad-beaf-477e-8d5c-0688123ac756",
    "name": "Cameras & Security",
    "slug": "electronics-cameras-security",
    "canonicalKey": "electronics.cameras-security",
    "active": true,
    "sortOrder": 8
  },
  {
    "id": "cbfed082-7b7e-45f1-ab4c-ee9d81477bb3",
    "parentId": "5ff935ad-beaf-477e-8d5c-0688123ac756",
    "name": "Electronic Accessories",
    "slug": "electronics-electronic-accessories",
    "canonicalKey": "electronics.electronic-accessories",
    "active": true,
    "sortOrder": 9
  },
  {
    "id": "ff6297c7-cf6f-42b2-92c8-811378122d91",
    "parentId": null,
    "name": "Beauty & Personal Care",
    "slug": "beauty-personal-care",
    "canonicalKey": "beauty-personal-care",
    "active": true,
    "sortOrder": 6
  },
  {
    "id": "b94f9a1a-ced0-4306-a0ef-881919371d84",
    "parentId": "ff6297c7-cf6f-42b2-92c8-811378122d91",
    "name": "Skincare",
    "slug": "beauty-personal-care-skincare",
    "canonicalKey": "beauty-personal-care.skincare",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "f67fd245-2e53-4566-b652-9d724a65b1b7",
    "parentId": "ff6297c7-cf6f-42b2-92c8-811378122d91",
    "name": "Hair Care",
    "slug": "beauty-personal-care-hair-care",
    "canonicalKey": "beauty-personal-care.hair-care",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "89b61289-c65f-47ad-aa2e-e0db2636e854",
    "parentId": "ff6297c7-cf6f-42b2-92c8-811378122d91",
    "name": "Makeup",
    "slug": "beauty-personal-care-makeup",
    "canonicalKey": "beauty-personal-care.makeup",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "d05bbb58-217e-49cb-927b-26666d63c84b",
    "parentId": "ff6297c7-cf6f-42b2-92c8-811378122d91",
    "name": "Personal Care",
    "slug": "beauty-personal-care-personal-care",
    "canonicalKey": "beauty-personal-care.personal-care",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "293f4791-0520-4f31-a291-7ea2fd6730aa",
    "parentId": "ff6297c7-cf6f-42b2-92c8-811378122d91",
    "name": "Fragrance",
    "slug": "beauty-personal-care-fragrance",
    "canonicalKey": "beauty-personal-care.fragrance",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "7852824a-0cb0-4b9f-9f97-ff85c0afaf53",
    "parentId": "ff6297c7-cf6f-42b2-92c8-811378122d91",
    "name": "Beauty Tools",
    "slug": "beauty-personal-care-beauty-tools",
    "canonicalKey": "beauty-personal-care.beauty-tools",
    "active": true,
    "sortOrder": 6
  },
  {
    "id": "5383c145-3042-4da5-9751-dec2ae233998",
    "parentId": null,
    "name": "Toys & Games",
    "slug": "toys-games",
    "canonicalKey": "toys-games",
    "active": true,
    "sortOrder": 7
  },
  {
    "id": "27885d5d-17f5-41fb-ae47-c76deba092c3",
    "parentId": "5383c145-3042-4da5-9751-dec2ae233998",
    "name": "Educational Toys",
    "slug": "toys-games-educational-toys",
    "canonicalKey": "toys-games.educational-toys",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "0255cc6c-c86b-4655-9160-341954d6a0b2",
    "parentId": "5383c145-3042-4da5-9751-dec2ae233998",
    "name": "Games & Puzzles",
    "slug": "toys-games-games-puzzles",
    "canonicalKey": "toys-games.games-puzzles",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "a00f25ba-6a0f-4e6e-b9e6-e7a93a6f172c",
    "parentId": "5383c145-3042-4da5-9751-dec2ae233998",
    "name": "Electronic Toys",
    "slug": "toys-games-electronic-toys",
    "canonicalKey": "toys-games.electronic-toys",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "64eee139-5b52-4cdc-87cf-ea18166968ad",
    "parentId": "5383c145-3042-4da5-9751-dec2ae233998",
    "name": "Outdoor Toys",
    "slug": "toys-games-outdoor-toys",
    "canonicalKey": "toys-games.outdoor-toys",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "aa1e3bfa-d673-4e87-b802-e45481c77953",
    "parentId": "5383c145-3042-4da5-9751-dec2ae233998",
    "name": "Collectibles",
    "slug": "toys-games-collectibles",
    "canonicalKey": "toys-games.collectibles",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "1882b46c-88be-4d28-9188-f8ca572649f9",
    "parentId": null,
    "name": "Sports & Outdoors",
    "slug": "sports-outdoors",
    "canonicalKey": "sports-outdoors",
    "active": true,
    "sortOrder": 8
  },
  {
    "id": "262aeba8-f478-414d-90cc-a2573ff3bfaa",
    "parentId": "1882b46c-88be-4d28-9188-f8ca572649f9",
    "name": "Fitness",
    "slug": "sports-outdoors-fitness",
    "canonicalKey": "sports-outdoors.fitness",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "9d870f89-a4ec-42a5-ac1e-1955a23c1805",
    "parentId": "1882b46c-88be-4d28-9188-f8ca572649f9",
    "name": "Outdoor & Camping",
    "slug": "sports-outdoors-outdoor-camping",
    "canonicalKey": "sports-outdoors.outdoor-camping",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "ae38b762-08c6-469d-91b4-f639a0db99d6",
    "parentId": "1882b46c-88be-4d28-9188-f8ca572649f9",
    "name": "Sports Equipment",
    "slug": "sports-outdoors-sports-equipment",
    "canonicalKey": "sports-outdoors.sports-equipment",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "7bdfe9a7-711c-4302-91a3-23974f086063",
    "parentId": "1882b46c-88be-4d28-9188-f8ca572649f9",
    "name": "Cycling",
    "slug": "sports-outdoors-cycling",
    "canonicalKey": "sports-outdoors.cycling",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "62effe08-78d5-4ec7-8036-c2a7331a2f9a",
    "parentId": "1882b46c-88be-4d28-9188-f8ca572649f9",
    "name": "Sports Accessories",
    "slug": "sports-outdoors-sports-accessories",
    "canonicalKey": "sports-outdoors.sports-accessories",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "54acfa4b-a0fe-444c-b697-e8d066d8ba42",
    "parentId": null,
    "name": "Travel & Luggage",
    "slug": "travel-luggage",
    "canonicalKey": "travel-luggage",
    "active": true,
    "sortOrder": 9
  },
  {
    "id": "21b7a277-819b-4b2b-b9c6-ccdd5246efe2",
    "parentId": "54acfa4b-a0fe-444c-b697-e8d066d8ba42",
    "name": "Suitcases",
    "slug": "travel-luggage-suitcases",
    "canonicalKey": "travel-luggage.suitcases",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "817208f0-43cc-4c23-a3ea-0c84be6b708b",
    "parentId": "54acfa4b-a0fe-444c-b697-e8d066d8ba42",
    "name": "Travel Bags",
    "slug": "travel-luggage-travel-bags",
    "canonicalKey": "travel-luggage.travel-bags",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "3aaf08af-d1a6-4661-a411-40826aaf8068",
    "parentId": "54acfa4b-a0fe-444c-b697-e8d066d8ba42",
    "name": "Backpacks",
    "slug": "travel-luggage-backpacks",
    "canonicalKey": "travel-luggage.backpacks",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "5dbb8d96-0ac5-40bb-8993-c58094adb556",
    "parentId": "54acfa4b-a0fe-444c-b697-e8d066d8ba42",
    "name": "Travel Accessories",
    "slug": "travel-luggage-travel-accessories",
    "canonicalKey": "travel-luggage.travel-accessories",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "7cd3d421-9f94-46ec-bb89-b68a36875a6f",
    "parentId": "54acfa4b-a0fe-444c-b697-e8d066d8ba42",
    "name": "Organizers",
    "slug": "travel-luggage-organizers",
    "canonicalKey": "travel-luggage.organizers",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "6a594015-0a27-4dda-babe-fe4c1ac6d439",
    "parentId": null,
    "name": "Office & Stationery",
    "slug": "office-stationery",
    "canonicalKey": "office-stationery",
    "active": true,
    "sortOrder": 10
  },
  {
    "id": "189463eb-0caa-4a1b-a1ee-a2e36dbd87f9",
    "parentId": "6a594015-0a27-4dda-babe-fe4c1ac6d439",
    "name": "Pens & Writing",
    "slug": "office-stationery-pens-writing",
    "canonicalKey": "office-stationery.pens-writing",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "d5bf34b4-2cac-4855-af0b-112108f99a81",
    "parentId": "6a594015-0a27-4dda-babe-fe4c1ac6d439",
    "name": "Desk Accessories",
    "slug": "office-stationery-desk-accessories",
    "canonicalKey": "office-stationery.desk-accessories",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "b227db2b-5ec4-430a-ad55-5d57a48dcc2a",
    "parentId": "6a594015-0a27-4dda-babe-fe4c1ac6d439",
    "name": "Office Supplies",
    "slug": "office-stationery-office-supplies",
    "canonicalKey": "office-stationery.office-supplies",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "4a383fe3-9968-42aa-b84c-b39e6dc6cd2d",
    "parentId": "6a594015-0a27-4dda-babe-fe4c1ac6d439",
    "name": "Storage & Filing",
    "slug": "office-stationery-storage-filing",
    "canonicalKey": "office-stationery.storage-filing",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "703e11b0-8f39-4fe5-8ee6-939d2a2d676f",
    "parentId": "6a594015-0a27-4dda-babe-fe4c1ac6d439",
    "name": "School Supplies",
    "slug": "office-stationery-school-supplies",
    "canonicalKey": "office-stationery.school-supplies",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "23391256-fdb9-4c97-b041-4141b2967d8b",
    "parentId": null,
    "name": "Pet Supplies",
    "slug": "pet-supplies",
    "canonicalKey": "pet-supplies",
    "active": true,
    "sortOrder": 11
  },
  {
    "id": "502b611a-9308-462a-a75d-773624cd16d9",
    "parentId": "23391256-fdb9-4c97-b041-4141b2967d8b",
    "name": "Dogs",
    "slug": "pet-supplies-dogs",
    "canonicalKey": "pet-supplies.dogs",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "fec6f5e1-2b1c-4ca7-b05a-63140e5e9dc5",
    "parentId": "23391256-fdb9-4c97-b041-4141b2967d8b",
    "name": "Cats",
    "slug": "pet-supplies-cats",
    "canonicalKey": "pet-supplies.cats",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "21443203-c7ec-4816-8639-e818f18bee23",
    "parentId": "23391256-fdb9-4c97-b041-4141b2967d8b",
    "name": "Feeding",
    "slug": "pet-supplies-feeding",
    "canonicalKey": "pet-supplies.feeding",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "48626dd5-62d6-4a1e-8b15-13cda5053f09",
    "parentId": "23391256-fdb9-4c97-b041-4141b2967d8b",
    "name": "Grooming",
    "slug": "pet-supplies-grooming",
    "canonicalKey": "pet-supplies.grooming",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "e36421e8-aafe-4723-a746-44699e5f2f7f",
    "parentId": "23391256-fdb9-4c97-b041-4141b2967d8b",
    "name": "Toys",
    "slug": "pet-supplies-toys",
    "canonicalKey": "pet-supplies.toys",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "706388f1-802d-4c82-942c-57e43b9a7f90",
    "parentId": "23391256-fdb9-4c97-b041-4141b2967d8b",
    "name": "Beds & Accessories",
    "slug": "pet-supplies-beds-accessories",
    "canonicalKey": "pet-supplies.beds-accessories",
    "active": true,
    "sortOrder": 6
  },
  {
    "id": "1ed62384-fcc9-435a-b21d-946bedc81543",
    "parentId": null,
    "name": "Automotive",
    "slug": "automotive",
    "canonicalKey": "automotive",
    "active": true,
    "sortOrder": 12
  },
  {
    "id": "0a942667-7e84-40dc-9a9f-38f6591ee667",
    "parentId": "1ed62384-fcc9-435a-b21d-946bedc81543",
    "name": "Car Accessories",
    "slug": "automotive-car-accessories",
    "canonicalKey": "automotive.car-accessories",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "e3d4ae3e-ea16-441b-9004-6fba6b0fcb0e",
    "parentId": "1ed62384-fcc9-435a-b21d-946bedc81543",
    "name": "Car Cleaning",
    "slug": "automotive-car-cleaning",
    "canonicalKey": "automotive.car-cleaning",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "f6b67b74-3112-45fc-ab07-bf524647f4d4",
    "parentId": "1ed62384-fcc9-435a-b21d-946bedc81543",
    "name": "Interior Accessories",
    "slug": "automotive-interior-accessories",
    "canonicalKey": "automotive.interior-accessories",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "2c9b8cca-088b-45e5-9282-e1e04836f54b",
    "parentId": "1ed62384-fcc9-435a-b21d-946bedc81543",
    "name": "Electronics",
    "slug": "automotive-electronics",
    "canonicalKey": "automotive.electronics",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "e5d31364-2874-4416-b5ea-3bee783a7032",
    "parentId": "1ed62384-fcc9-435a-b21d-946bedc81543",
    "name": "Tools & Maintenance",
    "slug": "automotive-tools-maintenance",
    "canonicalKey": "automotive.tools-maintenance",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "b9e93c5b-a07b-4ce8-9e8d-473376f1ed4a",
    "parentId": null,
    "name": "Tools & DIY",
    "slug": "tools-diy",
    "canonicalKey": "tools-diy",
    "active": true,
    "sortOrder": 13
  },
  {
    "id": "fd22e382-cc54-423e-b51b-d45be03e1215",
    "parentId": "b9e93c5b-a07b-4ce8-9e8d-473376f1ed4a",
    "name": "Hand Tools",
    "slug": "tools-diy-hand-tools",
    "canonicalKey": "tools-diy.hand-tools",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "729936d0-5060-4ef9-b971-82927b8c19c1",
    "parentId": "b9e93c5b-a07b-4ce8-9e8d-473376f1ed4a",
    "name": "Power Tool Accessories",
    "slug": "tools-diy-power-tool-accessories",
    "canonicalKey": "tools-diy.power-tool-accessories",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "7def75bf-83a8-43fa-9499-76b00d13bc63",
    "parentId": "b9e93c5b-a07b-4ce8-9e8d-473376f1ed4a",
    "name": "Hardware",
    "slug": "tools-diy-hardware",
    "canonicalKey": "tools-diy.hardware",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "bf8d8061-daeb-48a8-ba5b-561da09e48d8",
    "parentId": "b9e93c5b-a07b-4ce8-9e8d-473376f1ed4a",
    "name": "Electrical",
    "slug": "tools-diy-electrical",
    "canonicalKey": "tools-diy.electrical",
    "active": true,
    "sortOrder": 4
  },
  {
    "id": "da0ddc58-ef18-4cfd-ac07-247e69f1e4a4",
    "parentId": "b9e93c5b-a07b-4ce8-9e8d-473376f1ed4a",
    "name": "Home Improvement",
    "slug": "tools-diy-home-improvement",
    "canonicalKey": "tools-diy.home-improvement",
    "active": true,
    "sortOrder": 5
  },
  {
    "id": "8c49cbd1-f8f5-4e3b-a2dc-9f494f9713cc",
    "parentId": null,
    "name": "Health & Wellness",
    "slug": "health-wellness",
    "canonicalKey": "health-wellness",
    "active": true,
    "sortOrder": 14
  },
  {
    "id": "1dac7b90-c052-4f6a-a460-44a17cdf093c",
    "parentId": "8c49cbd1-f8f5-4e3b-a2dc-9f494f9713cc",
    "name": "Personal Wellness",
    "slug": "health-wellness-personal-wellness",
    "canonicalKey": "health-wellness.personal-wellness",
    "active": true,
    "sortOrder": 1
  },
  {
    "id": "186ffe1a-b52b-4273-a4f9-b49c0021a139",
    "parentId": "8c49cbd1-f8f5-4e3b-a2dc-9f494f9713cc",
    "name": "Mobility & Daily Living",
    "slug": "health-wellness-mobility-daily-living",
    "canonicalKey": "health-wellness.mobility-daily-living",
    "active": true,
    "sortOrder": 2
  },
  {
    "id": "fd565db1-fe6a-4016-aada-bdb7ca98b1cd",
    "parentId": "8c49cbd1-f8f5-4e3b-a2dc-9f494f9713cc",
    "name": "Health Accessories",
    "slug": "health-wellness-health-accessories",
    "canonicalKey": "health-wellness.health-accessories",
    "active": true,
    "sortOrder": 3
  },
  {
    "id": "2f5afcd5-463d-4c07-a56e-b47cf07a8bd5",
    "parentId": null,
    "name": "Other",
    "slug": "other",
    "canonicalKey": "other",
    "active": true,
    "sortOrder": 15
  },
  {
    "id": "d5bb3203-5b03-42dc-8a6a-3ac3ee757afc",
    "parentId": "2f5afcd5-463d-4c07-a56e-b47cf07a8bd5",
    "name": "Uncategorized",
    "slug": "other-uncategorized",
    "canonicalKey": "other.uncategorized",
    "active": true,
    "sortOrder": 1
  }
] as const;
