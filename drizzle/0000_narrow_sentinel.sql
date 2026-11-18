CREATE TYPE "public"."account_type" AS ENUM('personal', 'business');--> statement-breakpoint
CREATE TYPE "public"."address_type" AS ENUM('billing', 'shipping');--> statement-breakpoint
CREATE TYPE "public"."cart_status" AS ENUM('active', 'converted', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."chat_session_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."discount_type" AS ENUM('percentage', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_status" AS ENUM('unfulfilled', 'partially_fulfilled', 'fulfilled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."movement_type" AS ENUM('purchase', 'sale', 'return', 'damage', 'adjustment', 'transfer_in', 'transfer_out');--> statement-breakpoint
CREATE TYPE "public"."notification_campaign_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_platform" AS ENUM('ios', 'android', 'web');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'confirmed', 'processing', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."return_status" AS ENUM('requested', 'approved', 'received', 'rejected', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('pending', 'shipped', 'in_transit', 'delivered', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_status" AS ENUM('open', 'in_progress', 'waiting_customer', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending', 'active', 'suspended', 'deactivated');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"company_id" uuid,
	"type" "address_type" NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"company_name" varchar(200),
	"address_line_1" varchar(200) NOT NULL,
	"address_line_2" varchar(200),
	"city" varchar(100) NOT NULL,
	"postal_code" varchar(30) NOT NULL,
	"region" varchar(100),
	"country_code" varchar(2) NOT NULL,
	"phone" varchar(50),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "addresses_owner_check" CHECK (num_nonnulls("addresses"."user_id", "addresses"."company_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "admin_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"permission_key" varchar(150) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "admin_role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "admin_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "attribute_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attribute_id" uuid NOT NULL,
	"value" varchar(150) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_admin_id" uuid,
	"action" varchar(150) NOT NULL,
	"entity_type" varchar(100) NOT NULL,
	"entity_id" uuid,
	"old_values_json" jsonb,
	"new_values_json" jsonb,
	"ip_address" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(250) NOT NULL,
	"image_url" text,
	"link_url" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "banners_date_range_valid" CHECK ("banners"."end_at" IS NULL OR "banners"."end_at" >= "banners"."start_at")
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"slug" varchar(180) NOT NULL,
	"logo_url" text,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_quantity_positive" CHECK ("cart_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guest_session_id" varchar(200),
	"user_id" uuid,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"status" "cart_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_owner_check" CHECK (num_nonnulls("carts"."guest_session_id", "carts"."user_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" varchar(150) NOT NULL,
	"slug" varchar(180) NOT NULL,
	"description" text,
	"image_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"author_user_id" uuid,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"guest_session_id" varchar(200),
	"status" "chat_session_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_sessions_owner_check" CHECK (num_nonnulls("chat_sessions"."user_id", "chat_sessions"."guest_session_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_name" varchar(200) NOT NULL,
	"vat_number" varchar(50) NOT NULL,
	"registration_number" varchar(100),
	"contact_person" varchar(200) NOT NULL,
	"phone" varchar(50),
	"email" varchar(320) NOT NULL,
	"billing_address_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_users" (
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"company_role" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_users_company_id_user_id_pk" PRIMARY KEY("company_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "content_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(180) NOT NULL,
	"title" varchar(250) NOT NULL,
	"body_json" jsonb NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coupon_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" uuid,
	"discount_amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_usages_discount_nonnegative" CHECK ("coupon_usages"."discount_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(80) NOT NULL,
	"discount_type" "discount_type" NOT NULL,
	"discount_value" numeric(12, 2) NOT NULL,
	"minimum_order_value" numeric(12, 2),
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"usage_limit" integer,
	"usage_limit_per_customer" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_discount_nonnegative" CHECK ("coupons"."discount_value" >= 0),
	CONSTRAINT "coupons_percentage_valid" CHECK ("coupons"."discount_type" <> 'percentage' OR "coupons"."discount_value" <= 100),
	CONSTRAINT "coupons_minimum_value_nonnegative" CHECK ("coupons"."minimum_order_value" IS NULL OR "coupons"."minimum_order_value" >= 0),
	CONSTRAINT "coupons_usage_limits_positive" CHECK (
      ("coupons"."usage_limit" IS NULL OR "coupons"."usage_limit" > 0)
      AND ("coupons"."usage_limit_per_customer" IS NULL OR "coupons"."usage_limit_per_customer" > 0)
    ),
	CONSTRAINT "coupons_date_range_valid" CHECK ("coupons"."end_at" IS NULL OR "coupons"."start_at" IS NULL OR "coupons"."end_at" >= "coupons"."start_at")
);
--> statement-breakpoint
CREATE TABLE "homepage_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(120) NOT NULL,
	"title" varchar(250),
	"content_json" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"quantity_reserved" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_one_scope" CHECK (num_nonnulls("inventory"."product_id", "inventory"."variant_id") = 1),
	CONSTRAINT "inventory_quantities_nonnegative" CHECK ("inventory"."quantity_on_hand" >= 0 AND "inventory"."quantity_reserved" >= 0 AND "inventory"."low_stock_threshold" >= 0),
	CONSTRAINT "inventory_reserved_not_over_on_hand" CHECK ("inventory"."quantity_reserved" <= "inventory"."quantity_on_hand")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"movement_type" "movement_type" NOT NULL,
	"quantity" integer NOT NULL,
	"reference_type" varchar(100),
	"reference_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_one_scope" CHECK (num_nonnulls("inventory_movements"."product_id", "inventory_movements"."variant_id") = 1),
	CONSTRAINT "inventory_movements_quantity_positive" CHECK ("inventory_movements"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "notification_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"message" text NOT NULL,
	"audience_type" varchar(100) NOT NULL,
	"targeting_json" jsonb,
	"scheduled_at" timestamp with time zone,
	"status" "notification_campaign_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"company_id" uuid,
	"type" varchar(100) NOT NULL,
	"title" varchar(200) NOT NULL,
	"message" text NOT NULL,
	"data_json" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_recipient_check" CHECK (num_nonnulls("notifications"."user_id", "notifications"."company_id") >= 1)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"sku_snapshot" varchar(100) NOT NULL,
	"product_name_snapshot" varchar(250) NOT NULL,
	"variant_name_snapshot" varchar(200),
	"quantity" integer NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"cost_price_snapshot" numeric(12, 2) NOT NULL,
	"tax_rate_snapshot" numeric(5, 2) NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_amounts_nonnegative" CHECK ("order_items"."unit_price" >= 0 AND "order_items"."cost_price_snapshot" >= 0 AND "order_items"."line_total" >= 0),
	CONSTRAINT "order_items_tax_rate_valid" CHECK ("order_items"."tax_rate_snapshot" >= 0 AND "order_items"."tax_rate_snapshot" <= 100)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" varchar(40) NOT NULL,
	"user_id" uuid,
	"company_id" uuid,
	"guest_email" varchar(320),
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'pending' NOT NULL,
	"fulfillment_status" "fulfillment_status" DEFAULT 'unfulfilled' NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"discount_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"shipping_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(12, 2) NOT NULL,
	"billing_address_snapshot" jsonb NOT NULL,
	"shipping_address_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_customer_check" CHECK (num_nonnulls("orders"."user_id", "orders"."company_id", "orders"."guest_email") >= 1),
	CONSTRAINT "orders_totals_nonnegative" CHECK (
      "orders"."subtotal" >= 0 AND "orders"."discount_total" >= 0
      AND "orders"."shipping_total" >= 0 AND "orders"."tax_total" >= 0 AND "orders"."grand_total" >= 0
    )
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_event_id" varchar(200),
	"event_type" varchar(100) NOT NULL,
	"payload_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" varchar(80) NOT NULL,
	"provider_payment_id" varchar(200),
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"payment_method_type" varchar(80),
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_nonnegative" CHECK ("payments"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"min_quantity" integer NOT NULL,
	"max_quantity" integer,
	"unit_price" numeric(12, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_tiers_one_scope" CHECK (num_nonnulls("price_tiers"."product_id", "price_tiers"."variant_id") = 1),
	CONSTRAINT "price_tiers_min_quantity_valid" CHECK ("price_tiers"."min_quantity" > 0),
	CONSTRAINT "price_tiers_range_valid" CHECK ("price_tiers"."max_quantity" IS NULL OR "price_tiers"."max_quantity" >= "price_tiers"."min_quantity"),
	CONSTRAINT "price_tiers_price_nonnegative" CHECK ("price_tiers"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"type" "media_type" NOT NULL,
	"url" text NOT NULL,
	"alt_text" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_media_sort_order_nonnegative" CHECK ("product_media"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" varchar(100) NOT NULL,
	"barcode" varchar(100),
	"title" varchar(200) NOT NULL,
	"cost_price" numeric(12, 2),
	"base_price" numeric(12, 2),
	"weight" numeric(10, 3),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_cost_nonnegative" CHECK ("product_variants"."cost_price" IS NULL OR "product_variants"."cost_price" >= 0),
	CONSTRAINT "product_variants_base_nonnegative" CHECK ("product_variants"."base_price" IS NULL OR "product_variants"."base_price" >= 0),
	CONSTRAINT "product_variants_weight_nonnegative" CHECK ("product_variants"."weight" IS NULL OR "product_variants"."weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(250) NOT NULL,
	"slug" varchar(280) NOT NULL,
	"parent_sku" varchar(100) NOT NULL,
	"barcode" varchar(100),
	"brand_id" uuid,
	"category_id" uuid NOT NULL,
	"short_description" text,
	"description" text NOT NULL,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"cost_price" numeric(12, 2) NOT NULL,
	"base_price" numeric(12, 2) NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"weight" numeric(10, 3) NOT NULL,
	"width" numeric(10, 3),
	"height" numeric(10, 3),
	"length" numeric(10, 3),
	"featured" boolean DEFAULT false NOT NULL,
	"new_arrival" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_cost_price_nonnegative" CHECK ("products"."cost_price" >= 0),
	CONSTRAINT "products_base_price_nonnegative" CHECK ("products"."base_price" >= 0),
	CONSTRAINT "products_vat_rate_valid" CHECK ("products"."vat_rate" >= 0 AND "products"."vat_rate" <= 100),
	CONSTRAINT "products_weight_nonnegative" CHECK ("products"."weight" >= 0),
	CONSTRAINT "products_dimensions_nonnegative" CHECK (
      ("products"."width" IS NULL OR "products"."width" >= 0)
      AND ("products"."height" IS NULL OR "products"."height" >= 0)
      AND ("products"."length" IS NULL OR "products"."length" >= 0)
    )
);
--> statement-breakpoint
CREATE TABLE "promotion_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_campaigns_date_range_valid" CHECK ("promotion_campaigns"."end_at" IS NULL OR "promotion_campaigns"."end_at" >= "promotion_campaigns"."start_at")
);
--> statement-breakpoint
CREATE TABLE "promotion_categories" (
	"campaign_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "promotion_categories_campaign_id_category_id_pk" PRIMARY KEY("campaign_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "promotion_products" (
	"campaign_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "promotion_products_campaign_id_product_id_pk" PRIMARY KEY("campaign_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "notification_platform" NOT NULL,
	"push_token" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recently_viewed_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"guest_session_id" varchar(200),
	"product_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recently_viewed_owner_check" CHECK (num_nonnulls("recently_viewed_products"."user_id", "recently_viewed_products"."guest_session_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid,
	"return_request_id" uuid,
	"provider_reference" varchar(200),
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_nonnegative" CHECK ("refunds"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "return_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_request_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_items_quantity_positive" CHECK ("return_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "return_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" uuid,
	"reason" varchar(150) NOT NULL,
	"description" text,
	"status" "return_status" DEFAULT 'requested' NOT NULL,
	"admin_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"courier" varchar(100) NOT NULL,
	"tracking_number" varchar(150),
	"tracking_url" text,
	"status" "shipment_status" DEFAULT 'pending' NOT NULL,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid NOT NULL,
	"minimum_order_value" numeric(12, 2),
	"maximum_order_value" numeric(12, 2),
	"minimum_weight" numeric(10, 3),
	"maximum_weight" numeric(10, 3),
	"shipping_price" numeric(12, 2) NOT NULL,
	"free_shipping" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_rules_values_nonnegative" CHECK (
      ("shipping_rules"."minimum_order_value" IS NULL OR "shipping_rules"."minimum_order_value" >= 0)
      AND ("shipping_rules"."maximum_order_value" IS NULL OR "shipping_rules"."maximum_order_value" >= 0)
      AND "shipping_rules"."shipping_price" >= 0
      AND ("shipping_rules"."minimum_weight" IS NULL OR "shipping_rules"."minimum_weight" >= 0)
      AND ("shipping_rules"."maximum_weight" IS NULL OR "shipping_rules"."maximum_weight" >= 0)
    ),
	CONSTRAINT "shipping_rules_ranges_valid" CHECK (
      ("shipping_rules"."maximum_order_value" IS NULL OR "shipping_rules"."minimum_order_value" IS NULL OR "shipping_rules"."maximum_order_value" >= "shipping_rules"."minimum_order_value")
      AND ("shipping_rules"."maximum_weight" IS NULL OR "shipping_rules"."minimum_weight" IS NULL OR "shipping_rules"."maximum_weight" >= "shipping_rules"."minimum_weight")
    )
);
--> statement-breakpoint
CREATE TABLE "shipping_zone_countries" (
	"zone_id" uuid NOT NULL,
	"country_code" varchar(2) NOT NULL,
	CONSTRAINT "shipping_zone_countries_zone_id_country_code_pk" PRIMARY KEY("zone_id","country_code")
);
--> statement-breakpoint
CREATE TABLE "shipping_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_number" varchar(40) NOT NULL,
	"user_id" uuid,
	"company_id" uuid,
	"subject" varchar(250) NOT NULL,
	"status" "support_ticket_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"message_id" uuid,
	"file_name" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"mime_type" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_user_id" uuid,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" text,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"phone" varchar(50),
	"account_type" "account_type" DEFAULT 'personal' NOT NULL,
	"status" "user_status" DEFAULT 'pending' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant_attribute_values" (
	"variant_id" uuid NOT NULL,
	"attribute_value_id" uuid NOT NULL,
	CONSTRAINT "variant_attribute_values_variant_id_attribute_value_id_pk" PRIMARY KEY("variant_id","attribute_value_id")
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"code" varchar(50) NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wishlist_items" (
	"wishlist_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wishlist_items_wishlist_id_product_id_pk" PRIMARY KEY("wishlist_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "wishlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(150) DEFAULT 'Default wishlist' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_permissions" ADD CONSTRAINT "admin_role_permissions_role_id_admin_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."admin_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_permissions" ADD CONSTRAINT "admin_role_permissions_permission_id_admin_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."admin_permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_role_id_admin_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."admin_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_attribute_id_product_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."product_attributes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_admin_id_users_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_billing_address_id_addresses_id_fk" FOREIGN KEY ("billing_address_id") REFERENCES "public"."addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_users" ADD CONSTRAINT "company_users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_users" ADD CONSTRAINT "company_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_campaigns" ADD CONSTRAINT "notification_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_tiers" ADD CONSTRAINT "price_tiers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_tiers" ADD CONSTRAINT "price_tiers_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_categories" ADD CONSTRAINT "promotion_categories_campaign_id_promotion_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."promotion_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_categories" ADD CONSTRAINT "promotion_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_campaign_id_promotion_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."promotion_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_products" ADD CONSTRAINT "promotion_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recently_viewed_products" ADD CONSTRAINT "recently_viewed_products_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recently_viewed_products" ADD CONSTRAINT "recently_viewed_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_rules" ADD CONSTRAINT "shipping_rules_zone_id_shipping_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."shipping_zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_zone_countries" ADD CONSTRAINT "shipping_zone_countries_zone_id_shipping_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."shipping_zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_message_id_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_attribute_value_id_attribute_values_id_fk" FOREIGN KEY ("attribute_value_id") REFERENCES "public"."attribute_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_wishlist_id_wishlists_id_fk" FOREIGN KEY ("wishlist_id") REFERENCES "public"."wishlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_user_idx" ON "addresses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "addresses_company_idx" ON "addresses" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_permissions_key_unique" ON "admin_permissions" USING btree ("permission_key");--> statement-breakpoint
CREATE INDEX "admin_role_permissions_permission_idx" ON "admin_role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_roles_name_unique" ON "admin_roles" USING btree ("name");--> statement-breakpoint
CREATE INDEX "admin_roles_active_idx" ON "admin_roles" USING btree ("active");--> statement-breakpoint
CREATE INDEX "admin_user_roles_role_idx" ON "admin_user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_attribute_value_unique" ON "attribute_values" USING btree ("attribute_id","value");--> statement-breakpoint
CREATE INDEX "attribute_values_attribute_idx" ON "attribute_values" USING btree ("attribute_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "banners_active_dates_idx" ON "banners" USING btree ("active","start_at","end_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_unique" ON "brands" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_name_unique" ON "brands" USING btree ("name");--> statement-breakpoint
CREATE INDEX "brands_active_idx" ON "brands" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_product_variant_unique" ON "cart_items" USING btree ("cart_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "cart_items_cart_idx" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_guest_session_unique" ON "carts" USING btree ("guest_session_id");--> statement-breakpoint
CREATE INDEX "carts_user_status_idx" ON "carts" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_unique" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "categories_active_sort_idx" ON "categories" USING btree ("active","sort_order");--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_user_idx" ON "chat_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_guest_idx" ON "chat_sessions" USING btree ("guest_session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_vat_number_unique" ON "companies" USING btree ("vat_number");--> statement-breakpoint
CREATE INDEX "companies_email_idx" ON "companies" USING btree ("email");--> statement-breakpoint
CREATE INDEX "companies_created_at_idx" ON "companies" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "company_users_user_idx" ON "company_users" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_pages_slug_unique" ON "content_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "content_pages_status_idx" ON "content_pages" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_usages_coupon_order_unique" ON "coupon_usages" USING btree ("coupon_id","order_id");--> statement-breakpoint
CREATE INDEX "coupon_usages_user_idx" ON "coupon_usages" USING btree ("user_id","coupon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_code_unique" ON "coupons" USING btree ("code");--> statement-breakpoint
CREATE INDEX "coupons_active_dates_idx" ON "coupons" USING btree ("active","start_at","end_at");--> statement-breakpoint
CREATE UNIQUE INDEX "homepage_sections_key_unique" ON "homepage_sections" USING btree ("key");--> statement-breakpoint
CREATE INDEX "homepage_sections_active_sort_idx" ON "homepage_sections" USING btree ("active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_warehouse_product_unique" ON "inventory" USING btree ("warehouse_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_warehouse_variant_unique" ON "inventory" USING btree ("warehouse_id","variant_id");--> statement-breakpoint
CREATE INDEX "inventory_product_lookup_idx" ON "inventory" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "inventory_variant_lookup_idx" ON "inventory" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_product_idx" ON "inventory_movements" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_variant_idx" ON "inventory_movements" USING btree ("variant_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_warehouse_idx" ON "inventory_movements" USING btree ("warehouse_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_created_at_idx" ON "inventory_movements" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notification_campaigns_status_schedule_idx" ON "notification_campaigns" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "notifications_company_read_idx" ON "notifications" USING btree ("company_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_product_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_unique" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_company_idx" ON "orders" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_payment_status_idx" ON "orders" USING btree ("payment_status");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_guest_email_idx" ON "orders" USING btree ("guest_email");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_unique" ON "payment_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_events_payment_idx" ON "payment_events" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_payment_unique" ON "payments" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "price_tiers_product_idx" ON "price_tiers" USING btree ("product_id","min_quantity");--> statement-breakpoint
CREATE INDEX "price_tiers_variant_idx" ON "price_tiers" USING btree ("variant_id","min_quantity");--> statement-breakpoint
CREATE UNIQUE INDEX "product_attributes_slug_unique" ON "product_attributes" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "product_media_product_idx" ON "product_media" USING btree ("product_id","sort_order");--> statement-breakpoint
CREATE INDEX "product_media_variant_idx" ON "product_media" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_sku_unique" ON "product_variants" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_barcode_unique" ON "product_variants" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_variants_active_idx" ON "product_variants" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_unique" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "products_parent_sku_unique" ON "products" USING btree ("parent_sku");--> statement-breakpoint
CREATE UNIQUE INDEX "products_barcode_unique" ON "products" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_brand_idx" ON "products" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "products_featured_idx" ON "products" USING btree ("featured");--> statement-breakpoint
CREATE INDEX "products_new_arrival_idx" ON "products" USING btree ("new_arrival");--> statement-breakpoint
CREATE INDEX "products_created_at_idx" ON "products" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "promotion_campaigns_active_dates_idx" ON "promotion_campaigns" USING btree ("active","start_at","end_at");--> statement-breakpoint
CREATE INDEX "promotion_categories_category_idx" ON "promotion_categories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "promotion_products_product_idx" ON "promotion_products" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_token_unique" ON "push_devices" USING btree ("push_token");--> statement-breakpoint
CREATE INDEX "push_devices_user_active_idx" ON "push_devices" USING btree ("user_id","active");--> statement-breakpoint
CREATE INDEX "recently_viewed_user_idx" ON "recently_viewed_products" USING btree ("user_id","viewed_at");--> statement-breakpoint
CREATE INDEX "recently_viewed_guest_idx" ON "recently_viewed_products" USING btree ("guest_session_id","viewed_at");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_return_request_idx" ON "refunds" USING btree ("return_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_items_request_order_item_unique" ON "return_items" USING btree ("return_request_id","order_item_id");--> statement-breakpoint
CREATE INDEX "return_items_order_item_idx" ON "return_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "return_requests_order_idx" ON "return_requests" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "return_requests_user_idx" ON "return_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "return_requests_status_idx" ON "return_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_tracking_idx" ON "shipments" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shipping_rules_zone_idx" ON "shipping_rules" USING btree ("zone_id","priority");--> statement-breakpoint
CREATE INDEX "shipping_zone_countries_country_idx" ON "shipping_zone_countries" USING btree ("country_code");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_zones_name_unique" ON "shipping_zones" USING btree ("name");--> statement-breakpoint
CREATE INDEX "shipping_zones_active_idx" ON "shipping_zones" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_ticket_number_unique" ON "support_tickets" USING btree ("ticket_number");--> statement-breakpoint
CREATE INDEX "support_tickets_user_idx" ON "support_tickets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_company_idx" ON "support_tickets" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ticket_attachments_ticket_idx" ON "ticket_attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "variant_attribute_values_value_idx" ON "variant_attribute_values" USING btree ("attribute_value_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_code_unique" ON "warehouses" USING btree ("code");--> statement-breakpoint
CREATE INDEX "warehouses_active_idx" ON "warehouses" USING btree ("active");--> statement-breakpoint
CREATE INDEX "wishlist_items_product_idx" ON "wishlist_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "wishlists_user_idx" ON "wishlists" USING btree ("user_id");