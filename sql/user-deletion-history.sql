CREATE TABLE IF NOT EXISTS user_deletion_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  deleted_user_id INT,
  deleted_user_name VARCHAR(255) NOT NULL,
  deleted_user_email VARCHAR(255) NOT NULL,
  deleted_user_role VARCHAR(50) NOT NULL,
  deleted_by_admin_id INT,
  deleted_by_admin_name VARCHAR(255) NOT NULL,
  deletion_method VARCHAR(50) DEFAULT 'soft',
  deletion_status VARCHAR(50) DEFAULT 'success',
  deletion_reason VARCHAR(500),
  deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
