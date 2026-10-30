import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Maps the buildings table filled by the import scripts (scripts/buildings.sql), the worker only reads it.
@Index('buildings_tile_idx', ['tileZ', 'tileX', 'tileY'])
@Entity({ name: 'buildings', synchronize: false })
export class BuildingDb {
  @PrimaryColumn({ type: 'text' })
  public id!: string;

  @Column({ name: 'building_id', type: 'text' })
  public buildingId!: string;

  @Column({ type: 'text' })
  public source!: string;

  @Column({ type: 'geometry', spatialFeatureType: 'MultiPolygonZ', srid: 4326, select: false })
  public geom!: unknown;

  @Column({ name: 'face_labels', type: 'smallint', array: true, nullable: true })
  public faceLabels!: number[] | null;

  @Column({ name: 'ground_height', type: 'real' })
  public groundHeight!: number;

  @Column({ type: 'real' })
  public height!: number;

  @Column({ name: 'footprint_area', type: 'real', nullable: true })
  public footprintArea!: number | null;

  @Column({ name: 'construction_year', type: 'smallint', nullable: true })
  public constructionYear!: number | null;

  @Column({ name: 'roof_type', type: 'text', nullable: true })
  public roofType!: string | null;

  @Column({ name: 'tile_z', type: 'smallint' })
  public tileZ!: number;

  @Column({ name: 'tile_x', type: 'integer' })
  public tileX!: number;

  @Column({ name: 'tile_y', type: 'integer' })
  public tileY!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  public updatedAt!: Date;
}
