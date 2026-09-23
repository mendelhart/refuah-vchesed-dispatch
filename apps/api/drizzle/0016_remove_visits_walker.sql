-- The organisation does not do visits, and the walker option confused dispatchers.
UPDATE "service_types" SET "active" = false WHERE "slug" = 'visits';
--> statement-breakpoint
DELETE FROM "volunteer_services" WHERE "service_type_id" IN (SELECT "id" FROM "service_types" WHERE "slug" = 'visits');
--> statement-breakpoint
UPDATE "volunteer_applications" SET "requested_services" = array_remove("requested_services", 'visits') WHERE 'visits' = ANY("requested_services");
--> statement-breakpoint
UPDATE "trips" SET "mobility_needs" = array_remove("mobility_needs", 'walker') WHERE 'walker' = ANY("mobility_needs");
--> statement-breakpoint
UPDATE "recurring_rides" SET "mobility_needs" = array_remove("mobility_needs", 'walker') WHERE 'walker' = ANY("mobility_needs");
--> statement-breakpoint
UPDATE "users" SET "capabilities" = array_remove("capabilities", 'walker') WHERE 'walker' = ANY("capabilities");
--> statement-breakpoint
UPDATE "volunteer_applications" SET "capabilities" = array_remove("capabilities", 'walker') WHERE 'walker' = ANY("capabilities");
