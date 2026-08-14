require('dotenv').config();

async function deleteUndesirableAdmin() {
  const token = process.env.MAIN_ADMIN_TOKEN || process.env.ADMIN_10_TOKEN;
  const targetAdminId = Number(process.env.TARGET_ADMIN_ID);

  if (!token) {
    console.error('Missing MAIN_ADMIN_TOKEN in .env (older name: ADMIN_10_TOKEN is also accepted).');
    process.exit(1);
  }

  if (!targetAdminId) {
    console.error('Missing TARGET_ADMIN_ID in .env');
    process.exit(1);
  }

  if (targetAdminId === 10) {
    console.error('The primary admin ID 10 cannot be hard deleted. Choose another admin ID.');
    process.exit(1);
  }

  const url = `http://localhost:3000/api/admin/users/${targetAdminId}/force-admin-hard-delete`;

  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Delete failed.');
      console.error(data || { message: 'Unknown error' });
      process.exit(1);
    }

    console.log('Admin deleted successfully.');
    console.log(data);
  } catch (error) {
    console.error('Delete failed.');
    console.error(error.message);
    process.exit(1);
  }
}

deleteUndesirableAdmin();
